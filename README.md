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
