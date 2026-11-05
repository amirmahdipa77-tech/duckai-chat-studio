# PromptCLI · DuckAI Chat Studio

ترمینال و استودیوی Duck.ai — یک صفحهٔ استاتیک کامل که روی **GitHub Pages** کار می‌کند و به Duck.ai وصل می‌شود.
الهام‌گرفته از اپ PromptCLI (Duck.ai Terminal & API Studio): سه محیط، چرخش توکن VQD، بازرس پروتکل و استریم زنده.

## سه محیط

| محیط | چه می‌کند |
|---|---|
| **استودیو (GUI)** | گفتگوی فارسی راست‌به‌چپ با مارک‌داون، کد، جدول، کپی و «دوباره» |
| **ترمینال** | ترمینال واقعی با دستورات، ۵ تم رنگی و استریم کلمه‌به‌کلمه |
| **بازرس پروتکل** | هر دست‌دهی، چرخش توکن، پیام و خطا با هدرها و بدنهٔ JSON |

دستورات ترمینال: `/help` · `/models` · `/model <name>` · `/draw <prompt>` · `/clear` · `/status` · `/curl` · `/theme <name>` · `/mode`

## قرارداد API: `POST /api/duckchat`

```http
POST /api/duckchat
Content-Type: application/json

{ "prompt": "…", "model": "gpt-6-luna", "history": [{"role":"user","content":"…"}], "isDraw": false }
```

```
data: {"kind":"status","value":"در حال فکر کردن…"}
data: {"kind":"message","value":"سلام"}
data: {"kind":"done"}
```

`kind:"message"` کلمه‌به‌کلمه، `kind:"status"` وضعیت زنده و `kind:"done"` پایان است؛
`{"kind":"error","value":"…"}` هم مدیریت می‌شود. این endpoint در `app.py` و `worker.js` پیاده شده است.

## زنجیرهٔ موتورها (Fallback Resilient Engine)

| ترتیب | مسیر | نتیجه |
|---|---|---|
| ۱ | `POST /api/duckchat` (همان دامنه یا نشانی تنظیمات) | پاسخ از خود Duck.ai |
| ۲ | موتور مستقیم درون‌صفحه — توکن `x-vqd-4` + حل چالش `x-vqd-hash-1` در مرورگر | پاسخ از خود Duck.ai |
| ۳ | مسیر پشتیبان (سرویس مدل عمومی با CORS) | گفتگو کار می‌کند، ولی از Duck.ai نیست |

اگر موتوری خطا بدهد، زنجیره خودش موتور بعدی را امتحان می‌کند و مسیر فعال در نوار بالا نوشته می‌شود.
مسیر ۳ را می‌توانید در «تنظیمات اتصال» خاموش کنید.

## چرخش توکن VQD

هر درخواست با توکن تازه (`4-<timestamp>-<random>`) و در صورت دریافت ۴۱۸ با چالش تازه انجام می‌شود؛
توکن فعال در نوار بالا و پایین ترمینال دیده می‌شود و با کلیک کپی می‌شود.

## مدل‌ها

`gpt-6-luna` (پیش‌فرض) · `gpt-5.6-luna` · `gpt-5.4-mini` · `gpt-5.4-nano` ·
`claude-haiku-5-5` · `claude-haiku-4-5` · `tinfoil/gemma4-31b` · `tinfoil/gpt-oss-120b` · `mistral-small-2603`

## فایل‌ها

| فایل | کار |
|---|---|
| `index.html` | کل رابط (استودیو + ترمینال + بازرس) در یک فایل |
| `config.js` | نشانی سرور واسط |
| `worker.js` | واسط آماده برای Cloudflare Worker (بدون پایتون) |
| `app.py` | همان واسط با پایتون، برای اجرای محلی |
| `404.html` | صفحهٔ خطای GitHub Pages |

## اجرا

```bash
# استاتیک (GitHub Pages): همین است، کاری لازم نیست
# محلی با پایتون:
python3 app.py            # http://127.0.0.1:8000
python3 app.py --demo     # بدون اینترنت
```

## پروتکل دست‌دهی Duck.ai (مسیر ۲)

1. `GET https://duckduckgo.com/duckchat/v1/status` با هدر `x-vqd-accept: 1`
   → توکن `x-vqd-4` و در صورت وجود، چالش `x-vqd-hash-1`.
2. چالش از base64 باز می‌شود، کدش داخل همین صفحه اجرا می‌شود (به `navigator`/`document` نیاز دارد)،
   `client_hashes` با SHA-256 هش می‌شود و `meta` با `origin`/`stack`/`duration` تکمیل و دوباره base64 می‌شود.
3. `POST https://duckduckgo.com/duckchat/v1/chat` با `x-vqd-4` و `x-vqd-hash-1`
   و بدنهٔ `{model, messages:[{role, content:[{type:"text", text}]}], …}` → استریم SSE.

## نکته‌ها

- Duck.ai رابط رسمی ندارد؛ تغییر پروتکل یا محدودیت نرخ (۴۲۹) ممکن است رخ دهد — خطا در همان صفحه دیده می‌شود.
- تاریخچهٔ گفتگو فقط در `localStorage` مرورگر شما ذخیره می‌شود.
