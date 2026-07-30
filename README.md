# Wedding Photos — 結婚式写真収集サイト

結婚式のゲストがスマホからQRコード経由で写真・動画を送れるWebサイトです。
ログイン不要・合言葉のみでスパムを防ぎます。Cloudflare Workers + R2 で動作し、無料枠(ストレージ10GB)内で運用できます。

```
wedding-photos/
├── wrangler.toml        # Workers設定(静的アセット + R2バインディング)
├── src/index.js         # Worker本体(API + 静的配信)
├── public/
│   ├── index.html       # アップロードページ(ゲスト用)
│   ├── gallery.html     # ギャラリーページ(新郎新婦用)
│   ├── style.css
│   ├── app.js
│   └── gallery.js
├── scripts/
│   └── make-qr.mjs      # QRコードPNG生成
└── README.md
```

| 画面 | URL | 保護 |
|---|---|---|
| アップロード(ゲスト用) | `/` | 合言葉(`GUEST_PASSCODE`) |
| ギャラリー(新郎新婦用) | `/gallery` | 管理パスコード(`ADMIN_PASSCODE`) |
| ライブムービー(会場スクリーン用) | `/live` | 管理パスコード(`ADMIN_PASSCODE`) |

### ライブムービー(`/live`)について

会場のスクリーンに投影する演出用ページです。

- アップロード済みの写真がポラロイド風に右から左へ流れ続けます
- 5秒ごとに新着を確認し、新しい写真が届くと
  「◯◯さんから写真が届きました!」の通知とともに中央に大きく表示 → ムービーに合流します
- 右下のボタンで全画面表示にできます
- 動画ファイルはムービーには流れません(ギャラリーでのみ閲覧可)
- 上映用PCやタブレットのブラウザで開き、電源とWi-Fiを確保しておくことを推奨します

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

(ブラウザが開くのでCloudflareアカウントで許可)

```bash
npx wrangler r2 bucket create wedding-photos
```

### 1-4. 合言葉・管理パスコードの設定

秘密情報は `wrangler secret` で管理します(コードには書きません)。

```bash
npx wrangler secret put GUEST_PASSCODE
```

(プロンプトが出たら **ゲスト用の合言葉**(招待状に書くもの)を入力してEnter)

```bash
npx wrangler secret put ADMIN_PASSCODE
```

(プロンプトが出たら **新郎新婦用の管理パスコード** を入力してEnter。合言葉とは別の推測されにくいものにしてください)

### 1-5. デプロイ

```bash
npx wrangler deploy
```

成功すると `https://wedding-photos.<あなたのサブドメイン>.workers.dev` というURLが表示されます。
このURLがゲストに配るアップロードページです。ギャラリーは `/gallery` を付けたURLです。

---

## 2. QRコードの生成

デプロイで表示されたURLを渡して実行すると、`qr.png`(800×800px)が生成されます。

```bash
npm run qr -- https://wedding-photos.<あなたのサブドメイン>.workers.dev
```

招待状・席次表・会場の案内カードなどに印刷してご利用ください。

---

## 3. 写真の一括ダウンロード

ギャラリーからの一括ダウンロード機能はありません。以下の方法でR2から直接取得します。

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

4. 一括ダウンロード:

```bash
rclone copy r2:wedding-photos/photos ./wedding-photos-backup --progress
```

### 方法B: wrangler(少数のファイル向け)

APIで一覧を取得し、1件ずつ `wrangler r2 object get` で保存します。

```bash
mkdir -p download
curl -s -H "X-Admin-Passcode: <管理パスコード>" \
  https://wedding-photos.<サブドメイン>.workers.dev/api/photos \
  | node -e "JSON.parse(require('fs').readFileSync(0)).photos.forEach(p => console.log(p.key))" \
  | while read -r key; do
      npx wrangler r2 object get "wedding-photos/$key" --file "download/$(basename "$key")" --remote
    done
```

---

## 4. 無料枠の確認と課金目安

### 使用量の確認方法

ダッシュボード → **R2 Object Storage** → バケット `wedding-photos` を選択すると、
**ストレージ使用量・オブジェクト数・Class A/B オペレーション数** がグラフで確認できます。

### 無料枠(毎月)

| 項目 | 無料枠 | 本サイトでの消費 |
|---|---|---|
| ストレージ | 10 GB | 写真の保存分(累積) |
| Class A オペレーション(書き込み・一覧) | 100万回 | アップロード1枚 = 1回 |
| Class B オペレーション(読み取り) | 1000万回 | ギャラリー表示1枚 = 1回 |
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

## 5. ローカル開発・動作確認

ローカル用の合言葉は `.dev.vars` に書いてあります(本番とは別物。リポジトリにはコミットしないでください)。

```bash
npx wrangler dev
```

`http://localhost:8787` でアップロードページ、`/gallery` でギャラリーが開きます。
R2はローカルシミュレーションが使われるため、本番バケットには影響しません。

### curlでのAPI確認例

```bash
# アップロード
curl -X POST http://localhost:8787/api/upload \
  -H "X-Passcode: wedding2026" \
  -H "X-Uploader-Name: %E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E" \
  -H "Content-Type: image/jpeg" \
  --data-binary @test.jpg
```

```bash
# 一覧取得(管理パスコード必須)
curl http://localhost:8787/api/photos -H "X-Admin-Passcode: admin-secret"
```

---

## 6. 独自ドメインを使いたい場合(任意)

workers.dev のURLのままで問題ありませんが、独自ドメインを使う場合は:

1. ドメインのDNSをCloudflareに移管(ネームサーバー変更)
2. ダッシュボード → **Workers & Pages** → `wedding-photos` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**

---

## 運用メモ

- 合言葉を変えたいとき: `npx wrangler secret put GUEST_PASSCODE` を再実行して `npx wrangler deploy`
- 式の後は写真を一括ダウンロードし、バケットを削除すれば課金の心配はありません:
  ダッシュボードのバケット設定から削除(中身があると削除できないため、先にオブジェクトを空にする)
- 1ファイル上限は95MB(Workersのリクエスト上限100MBに対する安全マージン)
- HEIC/HEIFは変換せずそのまま保存されます(ギャラリーでの表示可否は閲覧ブラウザに依存します。iPhone/macのSafariでは表示できます)
