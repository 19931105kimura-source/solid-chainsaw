// test_alignment.js
const { buildReceiptText } = require("./src/domain");
const { enqueuePrint } = require("./src/printer");

const testItems = [
  { name: "AAAAAAAAAAAAAAAA", qty: 1, priceEx: 1000 }, // 半角16文字
  { name: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", qty: 1, priceEx: 1000 }, // 半角28文字
  { name: "ああああああああ", qty: 1, priceEx: 1000 }, // 全角8文字=16バイト
  { name: "ああああああああああああああ", qty: 1, priceEx: 1000 }, // 全角14文字=28バイト
];

const summary = { taxableSubtotal: 4000, tax: 400, service: 0, total: 4400 };

const segments = buildReceiptText({ tableId: "TEST", items: testItems, summary });
enqueuePrint(segments, "receipt")
  .then(() => { console.log("完了"); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });