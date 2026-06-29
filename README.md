# 大同發展中心 經費支出管理平台

多人即時協作的經費登打/審閱平台。使用 **Firebase**（登入帳號 + 資料庫）+ **GitHub Pages**（網站架設），全部免費額度即可使用，不需要會寫程式，照下面步驟操作即可。

三種角色：
- **登打者**：可新增／編輯／刪除支出紀錄
- **理事長**：唯讀檢視所有資料、可對單筆紀錄按「核可／退件」
- **主任**：登打者的全部權限 + 管理使用者角色 + 管理支出類別

---

## 步驟一：建立 Firebase 專案

1. 前往 https://console.firebase.google.com ，用 Google 帳號登入，點「新增專案」，輸入專案名稱（例如 `datong-expense`），一路下一步建立完成。
2. 左側選單 **Build → Authentication** → 點「開始使用」→ 在「Sign-in method」分頁啟用 **電子郵件/密碼**。
3. 左側選單 **Build → Firestore Database** → 點「建立資料庫」→ 選擇一個離台灣近的地區（如 `asia-east1`）→ 先選「正式環境模式」（規則之後會被下面的設定取代）。

## 步驟二：建立使用者帳號

在 **Authentication → Users** 頁面，點「新增使用者」，為主任自己、理事長、每位登打人員，各輸入一個 Email + 暫時密碼（之後他們可以用「忘記密碼」自行更換）。

> 這個平台**不開放自行註冊**，帳號都由主任在這裡手動建立，比較安全。

## 步驟三：設定 Firestore 安全規則

1. **Build → Firestore Database → 規則** 分頁。
2. 把這個資料夾裡的 `firestore.rules` 檔案內容整份貼上，取代原本內容，按「發布」。

這份規則確保：登打者/主任可寫入資料；理事長只能修改「核示狀態」欄位，不能竄改金額或摘要；使用者角色只有主任能設定。

## 步驟四：取得 Firebase 設定值，填入專案

1. Firebase 主控台左上角齒輪 → **專案設定** → 往下捲到「你的應用程式」→ 點 `</>`（網頁）圖示 → 輸入應用程式名稱（例如 `web`）→ 註冊。
2. 會出現一段 `const firebaseConfig = {...}`，複製裡面的內容。
3. 打開本資料夾的 `firebase-config.sample.js`，把範例值換成你複製的內容，**存檔後把檔名改成 `firebase-config.js`**（去掉 `.sample`）。

## 步驟五：上傳到 GitHub，啟用 GitHub Pages

1. 到 https://github.com 新增一個新的 repository（例如 `datong-expense`），可以設為 Public 或 Private（Private 也能用 GitHub Pages，但需 GitHub 付費方案；建議先用 Public，反正帳號密碼都靠 Firebase 驗證保護，靜態程式碼本身沒有機密資料）。
2. 把這個資料夾內全部檔案（`index.html`、`app.js`、`styles.css`、`firebase-config.js`、`firestore.rules`）上傳到該 repository（可直接在 GitHub 網頁「Add file → Upload files」拖曳上傳，不需要會用 Git 指令）。
3. Repository 的 **Settings → Pages** → Source 選擇 `Deploy from a branch` → Branch 選 `main` / 資料夾選 `/(root)` → Save。
4. 等 1～2 分鐘，畫面會出現網址，例如：
   `https://你的帳號.github.io/datong-expense/`

## 步驟六：把網站網址加入 Firebase 白名單

1. 回 Firebase 主控台 **Authentication → Settings → 已授權網域**。
2. 點「新增網域」，貼上 `你的帳號.github.io`（不用加 https://，也不用加後面的路徑）。

## 步驟七：第一次登入，把自己設成「主任」

1. 用瀏覽器打開步驟五取得的網址，用主任自己的帳密登入。
2. 登入後會看到「帳號已建立，等待設定權限」畫面（這是正常的，因為還沒有人有權限設定角色）。
3. 回到 Firebase 主控台 **Firestore Database → 資料**，找到 `users` collection，裡面會有一筆剛剛建立的文件（文件 ID 是一串亂碼）。點進去，把 `role` 欄位的值從 `pending` 改成 `admin`，存檔。
4. 回到網站重新登入，現在你就是「主任」角色，可以看到「使用者管理」分頁，之後其他人（理事長、登打人員）登入後第一次也會卡在「待設定」畫面，到「使用者管理」分頁把他們設成對應角色即可，不用再進 Firebase 主控台手動改。

完成！之後所有人只要打開同一個網址登入，登打資料會即時同步，理事長隨時都能看到最新狀況，並可在「明細清單」按「核可／退件」。每週也可以用「統計分析」分頁的「匯出 CSV」功能輸出該週資料給理事長存檔或書面審核。

---

## 維護備忘

- **新增/移除使用者**：到 Firebase 主控台 Authentication 新增帳號，對方登入後到「使用者管理」設定角色；要停用某人，直接到 Authentication 把帳號刪除或停用即可。
- **修改支出類別**：登打分頁的「＋ 新增支出類別」可直接新增，所有人即時看到。若要刪除/改名類別，到 Firestore Database 的 `config/categories` 文件直接編輯陣列。
- **費用**：本平台用量極小（一個機構、每天幾筆紀錄），完全在 Firebase 免費 Spark 方案額度內，不會產生費用。
- **資料備份**：建議每月用「統計分析」的 CSV 匯出功能下載一份留存，作為額外備份。

## Email 通知設定（選用功能）

開啟這個功能後：同仁登打新支出時會自動寄信通知主任；主任/理事長核可、退件或留審核備註時，會自動寄信通知原登打人員。

這個功能透過 **EmailJS**（免費額度每月 200 封信）讓網頁直接寄信，不需要自己架設寄信伺服器。在你完成設定之前，這個功能會自動停用，不影響網站其他功能正常使用。

### 步驟一：註冊 EmailJS 並連接信箱

1. 到 https://www.emailjs.com 註冊一個免費帳號
2. 左側選單 **Email Services** → **Add New Email Service** → 選 **Gmail**（或您慣用的信箱服務）→ 照畫面指示授權連接您要用來寄信的 Gmail 帳號
3. 連接成功後，記下這個 Service 的 **Service ID**（畫面上會顯示，類似 `service_xxxxxxx`）

### 步驟二：建立兩個郵件範本

到左側選單 **Email Templates** → **Create New Template**，建立**兩個**範本：

**範本一：新增支出通知主任**
- Subject（主旨）填：`【大同發展中心】{{recorder_name}} 新增了一筆支出登打`
- Content（內容）填：
```
{{recorder_name}} 剛剛登打了一筆新支出，請協助確認：

日期：{{date}}
類別：{{category}}
金額：{{amount}}
性質：{{type}}
摘要：{{desc}}
備註：{{note}}

請登入系統查看明細：{{link}}
```
- 收件人 To Email 欄位填：`{{to_email}}`
- 建立完成後記下這個範本的 **Template ID**（類似 `template_xxxxxxx`）

**範本二：審核結果通知登打人**
- Subject 填：`【大同發展中心】您登打的支出已有審核結果`
- Content 填：
```
您好 {{recorder_name}}，您登打的這筆支出有新的審核結果：

日期：{{date}}
類別：{{category}}
金額：{{amount}}
摘要：{{desc}}

核示狀態：{{status}}
審核留言：{{note}}
審核人員：{{reviewer_role}} {{reviewer_name}}

請登入系統查看明細：{{link}}
```
- 收件人 To Email 欄位同樣填：`{{to_email}}`
- 記下這個範本的 **Template ID**

### 步驟三：取得 Public Key

左側選單 **Account** → **General**，找到 **Public Key**，記下來。

### 步驟四：填入設定檔

把上面四個值（Public Key、Service ID、兩個 Template ID）告訴 Claude，或自己打開 `emailjs-config.js` 填入：

```js
export const emailjsConfig = {
  publicKey: "你的 Public Key",
  serviceId: "你的 Service ID",
  templateNewEntry: "新增支出通知主任的 Template ID",
  templateReview: "審核結果通知登打人的 Template ID"
};
```

存檔後上傳到 GitHub 覆蓋原檔案即可，**不需要重新部署其他檔案**。

### 步驟五：設定要通知的主任信箱

用主任帳號登入網站 → 「使用者管理」分頁最上面有「Email 通知設定」，填入要接收「新增支出通知」的信箱（可填多個，用逗號分隔）→ 按「儲存通知信箱」。

審核結果通知不需要額外設定，系統會自動找出每筆支出原本的登打人信箱寄送。

### 安全性提醒

`emailjs-config.js` 裡的 Public Key 設計上就是給瀏覽器端程式使用的，不是機密金鑰，但建議到 EmailJS 後台 **Account → Security** 設定 **Allowed origins**，只允許您的網站網域（例如 `renotzeng300-lang.github.io`）呼叫，避免被其他網站冒用您的寄信額度。

### 免費額度

EmailJS 免費方案每月 200 封信，對一般中心的登打量通常足夠。如果之後用量變大，可以在 EmailJS 後台升級付費方案。
