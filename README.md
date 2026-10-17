# Tesla Active Sound

**เสียงเครื่องยนต์จำลองสำหรับรถ Tesla — เปิดผ่าน Tesla Browser ได้ทันที**
Real-time active engine sound for Tesla, running entirely in the in-car browser.

### ▶ เปิดใช้งาน / Live app
**https://preemak03.github.io/TeslaActiveSound/**

หน้า GitHub เป็นโหมด Sim (ไม่มี CAN). ตอนขับจริงให้รันเซิร์ฟเวอร์ในเครือข่ายเดียวกับรถ แล้วเปิดที่อยู่ `http://` ของเครื่องนั้น — ดูด้านล่าง
No install, no account. Works offline after the first load of the page shell.

---

## ✨ ฟีเจอร์ / Features

- **15 โปรไฟล์เสียงเครื่องยนต์** — NA V12, RB26, 2JZ, F20C, Flat-6 911, S58, Coyote V8, K20C VTEC, VR6, 4G63, LS V8, B58, Rotary, Electric Hyper, Classic Muscle
- **เกียร์เสมือน 3 สปีด** พร้อม kickdown + rev-match (ท้าย G3 ≈ 120 km/h)
- **เสียงตามรถ** — WebSocket จาก CAN (หรือ mock) หรือโหมด Sim ปรับเอง
- **Launch Rev** — เบิ้ลเครื่องแบบควอเตอร์ไมล์ ลากรอบสับเกียร์ (ไม่ต้องขับ)
- **มิติหน้า–หลัง** — ย่านท่ออยู่หลัง ย่านเครื่องอยู่หน้า (psychoacoustic)
- **Drive Lock** — ล็อกปุ่มขณะขับเพื่อความปลอดภัย ปลดเมื่อจอดนิ่ง 3 วิ
- **ปรับตาม FPS ของรถอัตโนมัติ** (Tesla MCU2/MCU3) + ทำงาน offline

## 🎮 วิธีใช้ / Usage

| ปุ่ม | ทำอะไร |
|------|--------|
| **Push-to-Start** (ขวาล่าง) | ติด/ดับเครื่อง |
| **REV** (ข้างปุ่มสตาร์ท) | เบิ้ลเครื่องทดสอบเสียง |
| **Carousel** (กลางล่าง) | ปัดเลือกเสียงรถ |
| **CAN** (ขวาบน) | สลับความเร็วจาก CAN ↔ โหมด Sim |
| **Tune** (ซ้ายล่าง) | ปรับ Volume / Bass / Edge + ที่อยู่เซิร์ฟเวอร์ CAN + สไลเดอร์ Sim |

> โหมด CAN ต้องมีเซิร์ฟเวอร์ในเครือข่ายเดียวกัน · โหมด Sim เล่นได้โดยไม่ต้องใช้รถ

## CAN / mock server

GPS ไม่ได้ถูกใช้อีกต่อไป. ความเร็วมาจาก WebSocket

```bash
node can/server.mjs
```

เปิด **http://127.0.0.1:8787/** แล้วกด **Start**. โหมด mock ขับเองเป็นวง 20 วินาที (จอด → เร่งถึง 90 → คงที่ → regen หยุด) เพื่อลองโดยไม่มีรถ. ชิปขวาบนขึ้น **CAN Live** และวงความเร็วขยับตามสตรีม

ในรถ: เปิด `http://<ไอพีเครื่องที่รันเซิร์ฟเวอร์>:8787/` ใน Tesla Browser (ต้องเป็น **http** ของเซิร์ฟเวอร์นี้ — หน้า https ของ GitHub Pages จะบล็อก `ws://`). รายละเอียดสาย CAN, ไฟล์สัญญาณ Model 3 ที่ยังไม่ยืนยันบนรถ, และวิธีจูนท่อ/จำนวนสูบสำหรับเสียงถนนอยู่ใน [`docs/CAN.md`](docs/CAN.md)

```bash
node can/server.mjs --source socketcan --iface can0
node can/server.mjs --source serial --device /dev/ttyUSB0 --baud 115200
node can/server.mjs --source lines --file capture.log
node can/self-check.mjs
```

ตัวส่งในรถถูกเรียกว่า "tita" / "Tida" (สะกดไม่ชัด). เซิร์ฟเวอร์ไม่ผูกกับโปรโตคอลของผู้ผลิตคนใด — รับ SocketCAN, SLCAN, บรรทัด `ID HEX`, หรือ JSON. เพิ่มพาร์เซอร์ใน `can/parse.mjs` ถ้าเครื่องพูดอย่างอื่น

## 🛠 เทคนิค / Tech

Vanilla JavaScript + Web Audio API — เสียงทั้งหมดสังเคราะห์สด ไม่มีไฟล์เสียง ไม่มี dependency
Pure client-side · no build step · no external libraries. The CAN server is Node with no packages.

### ⛔ สถาปัตย์ Classic (กฏบังคับ — ห้ามละเลย)

**จูนจบที่โปรไฟล์ · engine เป็น pure player · validate ตอน save**

| เอกสาร | สำหรับ |
|--------|--------|
| [`AGENTS.md`](AGENTS.md) | AI / dev — LAW ทั้งชุด |
| [`docs/CLASSIC-CONTRACT.md`](docs/CLASSIC-CONTRACT.md) | สัญญาเต็ม + ตัวอย่างถูก/ผิด |
| [`docs/CAN.md`](docs/CAN.md) | CAN, Tesla browser, จูนท่อ/จำนวนสูบ |
| [`vessel/standards/CLASSIC.md`](vessel/standards/CLASSIC.md) | มาตรฐาน Classic ย่อ |

SoT: `assets/classic/{id}.classic.json` · อย่า sanitize เสียงใน `audio-engine` แทนการจูน  
Lab: [`docs/COMMAND-ROOM.md`](docs/COMMAND-ROOM.md)

---

## 📄 License

**© 2026 PreeMak03 — All rights reserved.**

โค้ดเปิดให้ดูเพื่อความโปร่งใส แต่**สงวนลิขสิทธิ์** — ห้ามคัดลอก ดัดแปลง หรือนำไป re-host
โดยไม่ได้รับอนุญาต ดูรายละเอียดใน [LICENSE](LICENSE)

Made with ♥ for the Tesla Thailand community.
