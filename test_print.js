// test_alignment.js
// 実行方法: node test_alignment.js
// ※ サーバーと同じディレクトリに置いて実行してください

const { buildReceiptText } = require("./src/domain");
const { enqueuePrint } = require("./src/printer");

const testItems = [
  {
    name: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 半角A×28文字
    qty: 1,
    priceEx: 1000,
  },
  {
    name: "ああああああああああああああ", // 全角あ×14文字
    qty: 1,
    priceEx: 1000,
  },
  {
    name: "あああああああAAAAAAAAAAAAAA", // 全角7文字＋半角14文字
    qty: 1,
    priceEx: 1000,
  },
];

const summary = {
  taxableSubtotal: 3000,
  tax: 300,
  service: 0,
  total: 3300,
};

const segments = buildReceiptText({
  tableId: "TEST",
  items: testItems,
  summary,
});

enqueuePrint(segments, "receipt")
  .then(() => {
    console.log("テスト印刷完了");
    process.exit(0);
  })
  .catch((err) => {
    console.error("印刷エラー:", err);
    process.exit(1);
  });