import type { Metadata } from "next";
import { Hanken_Grotesk, IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

const thai = IBM_Plex_Sans_Thai({
  variable: "--font-thai",
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PSC AI Chat · วิทยาลัยเทคโนโลยีพงษ์สวัสดิ์",
  description:
    "ระบบถาม-ตอบจากเอกสารจริงของวิทยาลัย ตอบพร้อมแหล่งอ้างอิง ไม่เดาคำตอบ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${hanken.variable} ${thai.variable} light h-full antialiased`}
    >
      <body className="min-h-full">
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
        {children}
      </body>
    </html>
  );
}
