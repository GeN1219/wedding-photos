# Wedding Photos — 結婚式写真収集サイト

結婚式のゲストがスマホからQRコード経由で写真・動画を送り、みんなで見て保存できるWebサイトです。
ログインも合言葉も不要です。Cloudflare Workers + R2 で動作し、無料枠(ストレージ10GB)内で運用できます。

```
wedding-photos/
├── wrangler.toml        # Workers設定(静的アセット + R2バインディング)
├── src/index.js         # Worker本体(API + 静的配信)
├── public/
│   ├── index.html       # トップページ(アップロード + みんなの写真)
│   ├── style.css
│   ├── app.js           # アップロード処理
│   ├── album.js         # みんなの写真の一覧・拡大表示・端末への保存
│   └── _redirects       # 旧 /gallery を / へ転送
├── scripts/
│   └── make-qr.mjs      # QRコードPNG生成
└── README.md
```

## 画面

ページは `/` の1枚だけです。

- **上部: アップロード**: お名前(任意)を入れて写真・動画を選び送信
- **下部: みんなの写真**: 投稿された写真が新しい順に並びます。タップで大きく表示し、「端末に保存」で保存できます
  - iPhone / Android: 共有メニューが開き「画像を保存」で写真アプリに保存(iPhoneは長押しでも保存可)
  - PC: 通常のファイルダウンロード
- 一覧には、アップロード時に端末側で作った縮小版(長辺480px)を表示して通信量を抑えています。保存されるのは原寸のオリジナルです

> **注意**: URLを知っている人は誰でも写真の閲覧・保存・投稿ができます。検索エンジンには載らない設定(noindex)にしていますが、QRコードやURLの扱いにはご注意ください。

---

## 1. セットアップ〜デプロイ手順

### 1-1. 事前準備

- [Node.js](https://nodejs.org/)(v18以上)をインストール
- [Cloudflareアカウント](https://dash.cloudflare.com/sign-up)を作成(無料プランでOK)

### 1-2. R2 を有効化する(初回のみ)

1. [Cloudflareダッシュボード](https://dash.cloudflare.com/) にログイン
2. 左メニューの **R2 Object Storage** を開く
3. 案内に従って R2 を有効化する
   - クレジットカードまたはPayPalの登録を求められますが、**無料枠(10GB)内なら課金されません**

### 1-3. デプロイ

このディレクトリで以下を順に実行します。

```bash
npm install
```

```bash
npx wrangler login
```

(ブラウザが開くのでCloudflareアカウントで許可。ログインの有効期限が切れたときも同じコマンドで再ログインします)

```bash
npx wrangler r2 bucket create wedding-photos
```

```bash
npx wrangler deploy
```

成功すると `https://wedding-photos.<あなたのサブドメイン>.workers.dev` というURLが表示されます。
このURLがゲストに配るページです。

---

## 2. QRコードの生成

デプロイで表示されたURLを渡して実行すると、`qr.png`(800×800px)が生成されます。

```bash
npm run qr -- https://wedding-photos.<あなたのサブドメイン>.workers.dev
```

招待状・席次表・会場の案内カードなどに印刷してご利用ください。

---

## 3. 写真の一括ダウンロード

サイト上は1枚ずつの保存です。全件まとめて取得するときは、以下の方法でR2から直接取得します。

### 方法A: rclone(推奨・高速)

1. [rclone](https://rclone.org/downloads/) をインストール(macOS: `brew install rclone`)
2. R2のAPIトークンを作成:
   - ダッシュボード → **R2 Object Storage** → **API** → **Manage API tokens** → **Create API token**
   - 権限は **Object Read only**、対象バケットは `wedding-photos` でOK
   - 表示される **Access Key ID** / **Secret Access Key** と、**アカウントID**(R2トップページの「S3 API」のURL `https://<アカウントID>.r2.cloudflarestorage.com` 部分)を控える
3. `~/.config/rclone/rclone.conf` に以下を追記:

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = https://<アカウントID>.r2.cloudflarestorage.com
```

4. 一括ダウンロード(`photos/` が原寸のオリジナル。縮小版の `thumbs/` は不要です):

```bash
rclone copy r2:wedding-photos/photos ./wedding-photos-backup --progress
```

### 方法B: wrangler(少数のファイル向け)

APIで一覧を取得し、1件ずつ `wrangler r2 object get` で保存します。

```bash
mkdir -p download
curl -s https://wedding-photos.<サブドメイン>.workers.dev/api/photos \
  | node -e "JSON.parse(require('fs').readFileSync(0)).photos.forEach(p => console.log(p.key))" \
  | while read -r key; do
      npx wrangler r2 object get "wedding-photos/$key" --file "download/$(basename "$key")" --remote
    done
```

---

## 4. 写真の削除(誤投稿など)

サイト上に削除ボタンはありません。キー(一覧APIの `key`、例: `photos/20261115-123456-abcd1234.jpg`)を指定して、オリジナルと縮小版の両方を削除します。

```bash
npx wrangler r2 object delete "wedding-photos/photos/20261115-123456-abcd1234.jpg" --remote
```

```bash
npx wrangler r2 object delete "wedding-photos/thumbs/20261115-123456-abcd1234.jpg.jpg" --remote
```

ダッシュボード → **R2 Object Storage** → `wedding-photos` からも削除できます。

---

## 5. 無料枠の確認と課金目安

### 使用量の確認方法

ダッシュボード → **R2 Object Storage** → バケット `wedding-photos` を選択すると、
**ストレージ使用量・オブジェクト数・Class A/B オペレーション数** がグラフで確認できます。

### 無料枠(毎月)

| 項目 | 無料枠 | 本サイトでの消費 |
|---|---|---|
| ストレージ | 10 GB | 写真の保存分(累積)。縮小版は1枚あたり約50KBでごくわずか |
| Class A オペレーション(書き込み・一覧) | 100万回 | アップロード1枚 = 2回(原寸+縮小版)、ページを開く = 2回 |
| Class B オペレーション(読み取り) | 1000万回 | 写真の表示・保存1回 = 1回 |
| 下り転送(egress) | 無制限・無料 | — |

写真1,000枚 + 動画で計10GB程度・ゲスト150人の想定なら、ストレージ以外は無料枠を使い切ることはまずありません。

### 超えた場合の課金目安(従量)

| 項目 | 単価 |
|---|---|
| ストレージ | $0.015 / GB・月(10GB超過分のみ) |
| Class A | $4.50 / 100万回 |
| Class B | $0.36 / 100万回 |

例: 合計15GBになった場合 → 超過5GB × $0.015 = **月額約$0.08(約12円)** 程度です。

### Workers無料枠

Workers自体の無料枠は **10万リクエスト/日**。1日で使い切ることは通常ありません。

---

## 6. ローカル開発・動作確認

```bash
npx wrangler dev
```

`http://localhost:8787` でページが開きます。
R2はローカルシミュレーションが使われるため、本番バケットには影響しません。

### curlでのAPI確認例

```bash
# アップロード
curl -X POST http://localhost:8787/api/upload \
  -H "X-Uploader-Name: %E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E" \
  -H "Content-Type: image/jpeg" \
  --data-binary @test.jpg
```

```bash
# 一覧取得
curl http://localhost:8787/api/photos
```

---

## 7. 独自ドメインを使いたい場合(任意)

workers.dev のURLのままで問題ありませんが、独自ドメインを使う場合は:

1. ドメインのDNSをCloudflareに移管(ネームサーバー変更)
2. ダッシュボード → **Workers & Pages** → `wedding-photos` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**

---

## 運用メモ

- スパム対策は「同一IPから1分間に60アップロードまで」の簡易制限のみです
- 式の後は写真を一括ダウンロードし、バケットを削除すれば課金の心配はありません:
  ダッシュボードのバケット設定から削除(中身があると削除できないため、先にオブジェクトを空にする)
- 1ファイル上限は95MB(Workersのリクエスト上限100MBに対する安全マージン)
- HEIC/HEIFは変換せずそのまま保存されます。AndroidのChrome等では表示できない場合がありますが(一覧には「HEIC」と表示)、保存は可能です
