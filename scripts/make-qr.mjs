// デプロイ後URLのQRコードPNGを生成するスクリプト
// 使い方: node scripts/make-qr.mjs https://wedding-photos.<subdomain>.workers.dev
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('使い方: node scripts/make-qr.mjs <デプロイ後のURL>');
  console.error('例:     node scripts/make-qr.mjs https://wedding-photos.example.workers.dev');
  process.exit(1);
}

const buf = await QRCode.toBuffer(url, {
  type: 'png',
  width: 800,
  margin: 2,
  errorCorrectionLevel: 'M',
});
await writeFile('qr.png', buf);
console.log(`qr.png を生成しました → ${url}`);
console.log('招待状や会場の案内カードに印刷してご利用ください。');
