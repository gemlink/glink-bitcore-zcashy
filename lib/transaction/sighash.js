'use strict';

var buffer = require('buffer');

var Signature = require('../crypto/signature');
var Transaction = require("./transaction")
var Script = require('../script');
var Output = require('./output');
var BufferReader = require('../encoding/bufferreader');
var BufferWriter = require('../encoding/bufferwriter');
var BN = require('../crypto/bn');
var Hash = require('../crypto/hash');
var ECDSA = require('../crypto/ecdsa');
var $ = require('../util/preconditions');
var BufferUtil = require('../util/buffer');
var blake2b = require('blake2b')
var _ = require('lodash');

var SIGHASH_SINGLE_BUG = '0000000000000000000000000000000000000000000000000000000000000001';
var BITS_64_ON = 'ffffffffffffffff';
var ZERO = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
var DEFAULT_BRANCH_ID = 0x76b809bb;

var sighashSapling = function sighash(transaction, sighashType, inputNumber, subscript) {
  // Copyright (C) 2019 by LitecoinZ Developers.
  //
  // Permission is hereby granted, free of charge, to any person obtaining a copy
  // of this software and associated documentation files (the "Software"), to deal
  // in the Software without restriction, including without limitation the rights
  // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  // copies of the Software, and to permit persons to whom the Software is
  // furnished to do so, subject to the following conditions:
  //
  // The above copyright notice and this permission notice shall be included in all
  // copies or substantial portions of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  // SOFTWARE.
  //
  var input = transaction.inputs[inputNumber];

  function getBlake2bHash(bufferToHash, personalization) {
    var out = Buffer.allocUnsafe(32);
    return blake2b(out.length, null, null, Buffer.from(personalization)).update(bufferToHash).digest(out);
  }

  function GetPrevoutHash(tx) {
    var writer = new BufferWriter()

    _.each(tx.inputs, function (input) {
      writer.writeReverse(input.prevTxId);
      writer.writeUInt32LE(input.outputIndex);
    });

    return getBlake2bHash(writer.toBuffer(), 'ZcashPrevoutHash');
  }

  function GetSequenceHash(tx) {
    var writer = new BufferWriter()

    _.each(tx.inputs, function (input) {
      writer.writeUInt32LE(input.sequenceNumber);
    });

    return getBlake2bHash(writer.toBuffer(), 'ZcashSequencHash');
  }

  function GetOutputsHash(tx, n) {
    var writer = new BufferWriter()

    if (_.isUndefined(n)) {
      _.each(tx.outputs, function (output) {
        output.toBufferWriter(writer);
      });
    } else {
      tx.outputs[n].toBufferWriter(writer);
    }

    return getBlake2bHash(writer.toBuffer(), 'ZcashOutputsHash');
  }

  var hashPrevouts = ZERO;
  var hashSequence = ZERO;
  var hashOutputs = ZERO;
  var hashJoinSplits = ZERO;
  var hashShieldedSpends = ZERO;
  var hashShieldedOutputs = ZERO;

  var writer = new BufferWriter();

  // header of the transaction (4-byte little endian)
  var header = transaction.version | (1 << 31);
  writer.writeInt32LE(header);

  // nVersionGroupId of the transaction (4-byte little endian)
  writer.writeUInt32LE(transaction.nVersionGroupId);

  // hashPrevouts (32-byte hash)
  if (!(sighashType & Signature.SIGHASH_ANYONECANPAY)) {
    hashPrevouts = GetPrevoutHash(transaction);
  }
  writer.write(hashPrevouts);

  // hashSequence (32-byte hash)
  if (!(sighashType & Signature.SIGHASH_ANYONECANPAY) &&
    (sighashType & 31) != Signature.SIGHASH_SINGLE &&
    (sighashType & 31) != Signature.SIGHASH_NONE) {
    hashSequence = GetSequenceHash(transaction);
  }
  writer.write(hashSequence);

  // hashOutputs (32-byte hash)
  if ((sighashType & 31) != Signature.SIGHASH_SINGLE && (sighashType & 31) != Signature.SIGHASH_NONE) {
    hashOutputs = GetOutputsHash(transaction);
  } else if ((sighashType & 31) == Signature.SIGHASH_SINGLE && inputNumber < transaction.outputs.length) {
    hashOutputs = GetOutputsHash(transaction, inputNumber);
  }
  writer.write(hashOutputs);

  // hashJoinSplits (32-byte hash)
  writer.write(hashJoinSplits);

  // hashShieldedSpends (32-byte hash)
  writer.write(hashShieldedSpends);

  // hashShieldedOutputs (32-byte hash)
  writer.write(hashShieldedOutputs);

  // nLockTime of the transaction (4-byte little endian)
  writer.writeUInt32LE(transaction.nLockTime);

  // nExpiryHeight of the transaction (4-byte little endian)
  writer.writeUInt32LE(transaction.nExpiryHeight);

  // valueBalance of the transaction (8-byte little endian)
  writer.writeUInt64LEBN(new BN(transaction.valueBalance));

  // sighash type of the signature (4-byte little endian)
  writer.writeUInt32LE(sighashType >>> 0);

  // outpoint (32-byte hash + 4-byte little endian)
  writer.writeReverse(input.prevTxId);
  writer.writeUInt32LE(input.outputIndex);

  // scriptCode of the input (serialized as scripts inside CTxOuts)
  writer.writeVarintNum(subscript.toBuffer().length)
  writer.write(subscript.toBuffer());

  // value of the output spent by this input (8-byte little endian)
  writer.writeUInt64LEBN(new BN(input.output.satoshis));

  // nSequence of the input (4-byte little endian)
  var sequenceNumber = input.sequenceNumber;
  writer.writeUInt32LE(sequenceNumber);

  var personalization = Buffer.alloc(16);
  var prefix = 'ZcashSigHash'
  var consensusBranchId = DEFAULT_BRANCH_ID;
  if (transaction.branchId) {
    consensusBranchId = transaction.branchId;
  }
  personalization.write(prefix);
  personalization.writeUInt32LE(consensusBranchId, prefix.length);
  var ret = getBlake2bHash(writer.toBuffer(), personalization)
  ret = new BufferReader(ret).readReverse();
  return ret;
}

/**
 * Returns a buffer of length 32 bytes with the hash that needs to be signed
 * for OP_CHECKSIG.
 *
 * @name Signing.sighash
 * @param {Transaction} transaction the transaction to sign
 * @param {number} sighashType the type of the hash
 * @param {number} inputNumber the input index for the signature
 * @param {Script} subscript the script that will be signed
 */
var sighash = function sighash(transaction, sighashType, inputNumber, subscript) {
  var Transaction = require('./transaction');
  var Input = require('./input');

  if (transaction.version >= 4) {
    return sighashSapling(transaction, sighashType, inputNumber, subscript);
  }

  var i;
  // Copy transaction
  var txcopy = Transaction.shallowCopy(transaction);

  // Copy script
  subscript = new Script(subscript);
  subscript.removeCodeseparators();

  for (i = 0; i < txcopy.inputs.length; i++) {
    // Blank signatures for other inputs
    txcopy.inputs[i] = new Input(txcopy.inputs[i]).setScript(Script.empty());
  }

  txcopy.inputs[inputNumber] = new Input(txcopy.inputs[inputNumber]).setScript(subscript);

  if ((sighashType & 31) === Signature.SIGHASH_NONE ||
    (sighashType & 31) === Signature.SIGHASH_SINGLE) {

    // clear all sequenceNumbers
    for (i = 0; i < txcopy.inputs.length; i++) {
      if (i !== inputNumber) {
        txcopy.inputs[i].sequenceNumber = 0;
      }
    }
  }

  if ((sighashType & 31) === Signature.SIGHASH_NONE) {
    txcopy.outputs = [];

  } else if ((sighashType & 31) === Signature.SIGHASH_SINGLE) {
    // The SIGHASH_SINGLE bug.
    // https://bitcointalk.org/index.php?topic=260595.0
    if (inputNumber >= txcopy.outputs.length) {
      return new Buffer(SIGHASH_SINGLE_BUG, 'hex');
    }

    txcopy.outputs.length = inputNumber + 1;

    for (i = 0; i < inputNumber; i++) {
      txcopy.outputs[i] = new Output({
        satoshis: BN.fromBuffer(new buffer.Buffer(BITS_64_ON, 'hex')),
        script: Script.empty()
      });
    }
  }

  if (sighashType & Signature.SIGHASH_ANYONECANPAY) {
    txcopy.inputs = [txcopy.inputs[inputNumber]];
  }

  var buf = new BufferWriter()
    .write(txcopy.toBuffer())
    .writeInt32LE(sighashType)
    .toBuffer();
  var ret = Hash.sha256sha256(buf);
  ret = new BufferReader(ret).readReverse();
  return ret;
};

/**
 * Create a signature
 *
 * @name Signing.sign
 * @param {Transaction} transaction
 * @param {PrivateKey} privateKey
 * @param {number} sighash
 * @param {number} inputIndex
 * @param {Script} subscript
 * @return {Signature}
 */
function sign(transaction, privateKey, sighashType, inputIndex, subscript) {
  var hashbuf = sighash(transaction, sighashType, inputIndex, subscript);
  var sig = ECDSA.sign(hashbuf, privateKey, 'little').set({
    nhashtype: sighashType
  });
  return sig;
}

/**
 * Verify a signature
 *
 * @name Signing.verify
 * @param {Transaction} transaction
 * @param {Signature} signature
 * @param {PublicKey} publicKey
 * @param {number} inputIndex
 * @param {Script} subscript
 * @return {boolean}
 */
function verify(transaction, signature, publicKey, inputIndex, subscript) {
  $.checkArgument(!_.isUndefined(transaction));
  $.checkArgument(!_.isUndefined(signature) && !_.isUndefined(signature.nhashtype));
  var hashbuf = sighash(transaction, signature.nhashtype, inputIndex, subscript);
  return ECDSA.verify(hashbuf, signature, publicKey, 'little');
}

/**
 * @namespace Signing
 */
module.exports = {
  sighash: sighash,
  sign: sign,
  verify: verify
};