# School RAG Chatbot Demo

ต้นแบบ chatbot สำหรับนำเสนอให้โรงเรียนหรือวิทยาลัย โดยให้ AI ตอบจากเอกสารจริงผ่าน RAG ไม่เดาคำตอบเอง

## Architecture

```text
ผู้ใช้
 -> หน้าเว็บ / LINE OA / Messenger
 -> Backend API
 -> Supabase Vector DB
 -> Gemini
 -> ตอบกลับพร้อมแหล่งอ้างอิง
```

## Stack

- Next.js App Router สำหรับหน้าเว็บและ backend API
- Gemini Flash สำหรับสร้างคำตอบ
- Gemini Embedding ขนาด 768 สำหรับค้น semantic search
- Supabase Postgres + pgvector สำหรับเก็บ `document_chunks`
- Tailwind CSS สำหรับ UI

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

ตั้งค่า `.env.local`:

```bash
GEMINI_API_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

ห้ามใส่ `GEMINI_API_KEY` หรือ `SUPABASE_SERVICE_ROLE_KEY` ใน frontend

## Fast Demo Ingestion

สำหรับ demo ให้โหลดข้อมูลเข้า Supabase ก่อนนำเสนอ ไม่ต้อง scrape สดระหว่างคุยกับผู้ชม

### Website pages

```bash
cp data/urls.example.txt data/urls.txt
```

ใส่ URL หน้าโรงเรียน/วิทยาลัยที่ต้องใช้ เช่น สมัครเรียน ค่าเทอม หลักสูตร ปฏิทิน ระเบียบ ทุน และช่องทางติดต่อ แล้วรัน:

```bash
npm run ingest:urls
```

สคริปต์จะ scrape HTML, cache text ไว้ที่ `data/sources/scraped`, ตัด chunk, ทำ Gemini embedding 768 dimensions, แล้ว insert ลง `document_chunks`

### Facebook / ประกาศที่ scrape ยาก

คัดลอกข้อความโพสต์ล่าสุดที่ต้องใช้ลงไฟล์:

```bash
data/sources/facebook-latest.md
```

จากนั้นรัน:

```bash
npm run ingest:files
```

### PDF คู่มือ/ประกาศ

ถ้ามี PDF เช่น คู่มือนักศึกษา ให้ใส่ URL ใน:

```bash
data/pdf-urls.txt
```

แล้วรัน:

```bash
npm run ingest:pdfs
```

### Calendar / ICS

ถ้าหน้าปฏิทินมีไฟล์ `.ics` ให้ใส่ URL ใน:

```bash
data/ics-urls.txt
```

แล้วรัน:

```bash
npm run ingest:ics
```

ค่า default จะดึงกิจกรรมตั้งแต่วันที่ 1 มกราคมของปีปัจจุบัน ถ้าต้องการกำหนดเอง:

```bash
npm run ingest:ics -- --from=2026-01-01
```

ถ้าต้องการเช็กจำนวน chunk โดยยังไม่ยิง Gemini/Supabase:

```bash
npm run ingest:urls -- --dry-run
npm run ingest:files -- --dry-run
npm run ingest:ics -- --dry-run
npm run ingest:pdfs -- --dry-run
```

การรันซ้ำจะลบ chunk เดิมของ source เดิมก่อน insert ใหม่ เพื่อให้ข้อมูล demo สดขึ้นและไม่ duplicate

## Supabase

รัน SQL migration ที่ `supabase/migrations/001_create_document_chunks.sql` ใน Supabase SQL Editor เพื่อเปิด pgvector, สร้างตาราง `document_chunks`, function `match_documents`, และ HNSW index

Schema นี้ใช้ `extensions.vector(768)` ดังนั้น embedding ที่ insert ต้องมี 768 dimensions เท่านั้น และไม่ควรปน embedding จากคนละ model หรือคนละ dimension ในตารางเดียวกัน

## API Flow

`POST /api/chat`

```json
{
  "question": "สมัครเรียนต้องใช้เอกสารอะไรบ้าง"
}
```

Backend จะทำงานตามลำดับ:

1. สร้าง embedding ของคำถามด้วย Gemini
2. เรียก Supabase RPC `match_documents`
3. ถ้าไม่เจอ context จะตอบว่าไม่พบข้อมูลในเอกสาร
4. ถ้าเจอ context จะส่งข้อมูลที่ค้นเจอให้ Gemini ตอบพร้อมแหล่งอ้างอิง

## Document Ingestion ที่ต้องทำต่อ

```text
PDF / เว็บ / FAQ
 -> แยกข้อความ
 -> ตัดเป็น chunk
 -> ทำ embedding ขนาด 768
 -> insert ลง document_chunks
```

metadata ที่แนะนำ: `page`, `category`, `year`, `source_url`
