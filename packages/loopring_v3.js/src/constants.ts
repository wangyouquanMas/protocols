import BN from "bn.js";
import { FloatEncoding } from "./float";
import { Balance } from "./types";

export class Constants {
  static readonly BINARY_TREE_DEPTH_STORAGE = 14;
  static readonly BINARY_TREE_DEPTH_ACCOUNTS = 32;
  static readonly BINARY_TREE_DEPTH_TOKENS = 32;

  static readonly TX_DATA_AVAILABILITY_SIZE = 83;

  static readonly TX_DATA_AVAILABILITY_SIZE_PART_1 = 80;
  static readonly TX_DATA_AVAILABILITY_SIZE_PART_2 = 3;

  static readonly NUM_BITS_ACCOUNTID = Constants.BINARY_TREE_DEPTH_ACCOUNTS;
  static readonly NUM_BITS_STORAGEID = 32;
  static readonly NUM_STORAGE_SLOTS = 2 ** Constants.BINARY_TREE_DEPTH_STORAGE;

  static readonly MAX_NUM_TOKENS = 4 ** 16;

  static readonly MAX_AMOUNT = new BN(2).pow(new BN(248)).sub(new BN(1));

  static readonly FEE_MULTIPLIER = 50;

  static readonly Float32Encoding: FloatEncoding = {
    numBitsExponent: 7,
    numBitsMantissa: 25,
    exponentBase: 10
  };

  static readonly Float29Encoding: FloatEncoding = {
    numBitsExponent: 5,
    numBitsMantissa: 24,
    exponentBase: 10
  };

  static readonly Float24Encoding: FloatEncoding = {
    numBitsExponent: 5,
    numBitsMantissa: 19,
    exponentBase: 10
  };

  static readonly Float23Encoding: FloatEncoding = {
    numBitsExponent: 5,
    numBitsMantissa: 18,
    exponentBase: 10
  };

  static readonly Float16Encoding: FloatEncoding = {
    numBitsExponent: 5,
    numBitsMantissa: 11,
    exponentBase: 10
  };

  static readonly emptyBytes: any = [];
  static readonly zeroAddress = "0x" + "00".repeat(20);

  static readonly scalarField = new BN(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617",
    10
  );

  static readonly DefaultBalance: Balance = {
    balance: new BN(0)
  };
}
