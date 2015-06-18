"use strict";

/* jshint node: true */
var Class = require('./class'),
  EventEmitter = require('events').EventEmitter,
  commands = require('./commands'),
  POLYNOMIAL = 0x08408,
  T_FREE = 20,
  T_RESPONSE = 5000,
  T_POLL = 500,
  MAX_COMMAND_ATTEMPTS = 3;

/**
 * CashCode NET Class
 * config includes
 * @param string device device address. e.g. /dev/ttyS0 or COM1
 * @param hex type device type as follows:
 * <ul>
 * <li>0x01 - Bill-to-Bill unit
 * <li>0x02 - Coin Exchanger
 * <li>0x03 - Bill Validator
 * <li>0x04 - Card Reader
 * </ul>
 * @class ccnet
 * @type @exp;Class@call;extend
 */
var ccnet = Class.extend({
  port: null,
  opened: false,
  busy: false,
  enabled: false,
  name: null,
  type: null,
  commands: null,
  states: null,
  hasError: false,
  buffer: [],
  commandQueue: [],
  commandExecutionTimerId: null,
  initialize: function (config) {
    if (!config.device) {
      throw new Error('No device defined');
    }
    if (commands[config.type] === false) {
      throw new Error('Not yet implemented');
    }
    if (!commands[config.type]) {
      throw new Error('Wrong peripheral address');
    }
    var SerialPort = require("serialport").SerialPort,
      self = this;
    //TODO: autodetect device
    this.port = new SerialPort(config.device, {
      baudrate: 9600,
      stopbits: 1,
      databits: 8
    }, false);
    this.hasError = false;
    this.port.on('error', function (err) {
      self.emit(err);
    });
    this.port.on('close', function () {
      self.opened = false;
      self.emit("CLOSED");
    });
    this.port.open(function () {
      self.type = config.type;
      self.states = commands[config.type].states;
      self.commands = commands[config.type].commands;
      function createCommand(command) {
        self[command] = function (data, callback) {
          return self.execute.call(self, command, data, callback);
        };
      }
      for (var command in self.commands) {
        createCommand(command);
      }
      self.opened = true;
      self.port.on('data', function (data) {
        var dataArray = data.toJSON().data;
        self.buffer.push.apply(self.buffer, dataArray);
        self._processBuffer();
      });
      self.emit('ready');
    });
  },
  _checkCRC16: function (packet) {
    var packetLength = packet.length;
    var crc = this.getCRC16(packet.slice(0, packetLength - 2));
    var packetCrc = (packet[packetLength - 2] & 0xFF) |
      (packet[packetLength - 1] & 0xFF) << 8;
    return packetCrc === crc;
  },
  _processBuffer: function () {
    var err = null;
    var data = null;
    var bufferLength = this.buffer[2];
    // Message is not fully received
    if (!this.buffer.length || this.buffer.length < 3 ||
          this.buffer.length < bufferLength) {
      return;
    }
    var packetLength = this.buffer[2];
    // Possible sync problem
    if (this.buffer[0] !== 0x02 || this.buffer[1] !== this.type) {
      console.warn('Possible sync problem');
    }
    if (!this._checkCRC16(this.buffer.slice(0, packetLength))) {
      // CTC check failed
      console.warn('crc is invalid');
      this._sendAcknoledgement(false);
      this._finishCommandExecution('FAILED_CRC');
    }
    else {
      this._sendAcknoledgement(true);
      data = this.buffer.slice(3, bufferLength - 2);
      if (data.length === 1 && data[0] === 0x30) {
        this._finishCommandExecution('ILLEGAL_COMMAND');
      }
      else {
        this._finishCommandExecution(null, data);
      }
    }
  },

  _finishCommandExecution: function (err, data) {
    var commandItem = this.commandQueue.shift();
    if (!commandItem) {
      return;
    }
    commandItem[1](null, data);
    this.busy = false;
    if (commandItem[0][3] === this.commands.poll) {
      this._finishPoll(data);
    }
    if (this.commandQueue.length) {
      setTimeout(this._executeQueue.bind(this), T_FREE);
    }
    else if (this.enabled) {
      setTimeout(this.poll, T_POLL);
    }
  },

  _finishPoll: function (data) {
    switch (data[0]) {
      case 0x10:
        return this.emit('POWER_UP');
      case 0x11:
        return this.emit('POWER_UP_WITH_BILL_IN_VALIDATOR');
      case 0x12:
        return this.emit('POWER_UP_WITH_BILL_IN_STACKER');
      case 0x13:
        return this.emit('INITIALIZE');
      case 0x14:
        return this.emit('IDLING');
      case 0x15:
        return this.emit('ACCEPTING');
      case 0x17:
        return this.emit('STACKING');
      case 0x18:
        return this.emit('RETURNING');
      case 0x19:
        return this.emit('DISABLED');
      case 0x1A:
        return this.emit('HOLDING');
      case 0x1B:
        // TODO: there is an expiration time
        return this.emit('BUSY');
      case 0x1C:
        // TODO: there is rejection reason
        return this.emit('REJECTED');
      case 0x41:
        return this.emit('DROP_CASSETTE_FULL');
      case 0x42:
        return this.emit('DROP_CASSETE_OUT_OF_POSITION');
      case 0x43:
        return this.emit('VALIDATOR_JAMMED');
      case 0x44:
        return this.emit('DROP_CASSETTE_JAMMED');
      case 0x45:
        return this.emit('CHEATED');
      case 0x46:
        return this.emit('PAUSE');
      case 0x47:
        // TODO: there is description byte
        return this.emit('FAILURE');
      case 0x80:
        return this.emit('ESCROW', data[1]);
      case 0x81:
        return this.emit('STACKED', data[1]);
      case 0x82:
        return this.emit('RETURNED', data[1]);
    }
  },
  _writeToPort: function (data, callback) {
    var self = this;
    self.port.write(data, function (err) {
      if (err) {
        callback(err);
        return;
      }
      self.port.drain(callback);
    });
  },
  _sendAcknoledgement: function (acknoledged, callback) {
    var data = (acknoledged) ? 0x00 : 0xFF;
    var packet = new Buffer([0x02, this.type, 0x06, data]);
    var crc = this.getCRC16(packet, true);
    packet = Buffer.concat([packet, crc]);
    this._writeToPort(packet, callback);
  },
  _executeQueue: function () {
    var self = this;
    if (self.busy) {
      return;
    }
    if (self.commandQueue.length) {
      self.buffer = [];
      var packet = self.commandQueue[0][0];
      self.busy = true;
      self._writeToPort(packet, function (err) {
        if (err) {
          self._finishCommandExecution(err);
          return;
        }
      });
    }
  },
  enable: function (b1, b2, b3, e1, e2, e3, callback) {
    this.enabled = true;
    this.enable_bill_types([b1, b2, b3, e1, e2, e3]);
    this.set_security([b1, b2, b3], callback);
  },
  disable: function (callback) {
    this.enabled = false;
    this.enable_bill_types([0, 0, 0, 0, 0, 0], callback);
  },
  execute: function (command, data, callback) {
    var self = this;
    if ('function' === typeof data) {
      callback = data;
      data = [];
    } else if ('function' !== typeof callback) {
      callback = function () {};
    }
    if (!data) {
      data = [];
    }
    if (!(data instanceof Buffer)) {
      data = new Buffer(data);
    }
    command = new Buffer([self.commands[command.toLowerCase()]]);
    //TODO: data length > 255
    var length = data.length + 6;
    var packet = Buffer.concat([new Buffer([0x02, this.type, length]), command, data]);
    var crc = self.getCRC16(packet, true);
    packet = Buffer.concat([packet, crc]);
    self.commandQueue.push([packet, callback]);
    setTimeout(self._executeQueue.bind(self), T_FREE);
  },
  getCRC16: function (data, asBuffer) {
    asBuffer = asBuffer ? true : false;
    var CRC = 0, i, j, length = data.length;
    for (i = 0; i < length; i++) {
      CRC ^= data[i];
      for (j = 0; j < 8; j++) {
        if (CRC & 0x0001) {
          CRC >>= 1;
          CRC ^= POLYNOMIAL;
        }
        else {
          CRC >>= 1;
        }
      }
    }
    if (asBuffer) {
      var buf = new Buffer(2);
      buf.writeUInt16LE(CRC, 0);
      CRC = buf;
    }
    return CRC;
  }
});

ccnet.prototype.__proto__ = EventEmitter.prototype;

module.exports = ccnet;
