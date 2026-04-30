import * as bip39 from 'bip39';

const mnemonic = bip39.generateMnemonic(); // 默认生成 12 词助记词
console.log("\n====== 您的助记词 (Mnemonic Phrase) ======\n");
console.log(mnemonic);
console.log("\n===========================================\n");