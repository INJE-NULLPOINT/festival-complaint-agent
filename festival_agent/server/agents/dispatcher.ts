// ③ 조치 에이전트 (Dispatcher) — Agent Path. (agents/dispatcher.py 와 1:1)
//
// 목표: 심각 이슈를 담당 부서가 바로 쓸 수 있는 문서로 만든다.
// 에이전트의 판단: 어떤 원문을 대표로 인용할지, 어떤 조치를 제안할지.
// 코드가 하는 일: 부서 매핑 조회, DOCX 생성, 상태 기록.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { BASE_DIR, config } from "../core/config.ts";
import * as db from "../core/db.ts";
import * as issues from "../core/issues.ts";
import { Agent, tool } from "../core/llm.ts";
import * as rules from "../core/rules.ts";
import * as severity from "../core/severity.ts";
import { lookup_festival_info } from "./common.ts";

export type Row = Record<string, any>;

// 요청서 저장 폴더. 테스트가 임시 폴더로 바꿀 수 있게 바꿀 수 있는 객체에 둔다.
export const paths = { OUT_DIR: path.join(BASE_DIR, "output") };

// 파일명에 쓸 수 없는 문자. 라벨에 '/'가 들어있어("안내/동선") 경로로 해석되면서 DOCX 저장이 실패한 적이 있다.
/** Windows 파일명으로 안전한 문자열로 바꾼다. */
export function _safe(name: string | null | undefined): string {
  const out = (name || "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/^[ .]+|[ .]+$/g, "");
  return out || "미상";
}

export const SYSTEM = `너는 지역 축제 운영 관제 시스템의 '조치 에이전트'다.

역할: 심각도가 높은 민원 유형에 대해, 담당 부서가 받아서 바로 움직일 수 있는 조치요청서를 만든다.

절차
1. get_department 로 담당 부서를 확인한다.
2. collect_quotes 로 해당 유형의 민원 원문을 가져온다.
3. 그중 **대표성 있는 5건 이내**를 직접 고른다. 기준: 서로 다른 구역의 사례를 섞는다 / 구체적 상황이 드러난 문장
   ("불편함" 같은 모호한 것은 제외) / 안전 관련이면 위험 상황이 명확한 것을 우선한다.
4. lookup_festival_info 로 축제 공식 정보를 조회해 문서 머리말에 넣는다. 실패하면(null) 축제명만 쓰고, 없는 정보를 지어내지 마라.
5. 조치 제안을 쓴다. **현장에서 오늘 실행 가능한 것만** 쓴다 (예산 편성·조례 개정 같은 장기 과제는 쓰지 않는다).
   요청문에 '관제 카드의 조치'가 주어지면 그 문장을 그대로(문장·순서 유지) 제안으로 쓴다 — 관제 화면과 요청서의 조치가
   다르면 안 된다. 주어지지 않았을 때만 2~3개를 직접 쓴다.
6. generate_doc 으로 문서를 만들고, 무엇을 만들었는지 한 문장으로 보고한다.

반드시 지킬 것
- 인용은 원문 그대로 쓴다. 문장을 고쳐 쓰지 마라.
- 건수는 주어진 값을 그대로 쓰고 추정하지 마라. 점수·계산식은 문서에 쓰지 않는다 (판정 근거는 주어진 문장을 그대로 쓴다).
`;

export const get_department = tool({
  name: "get_department",
  description: "민원 유형의 담당 부서와 연락처를 조회한다.",
  properties: { label: { type: "string", enum: Object.keys(config.LABELS) } },
  required: ["label"],
  params: ["label"],
}, (label: string): Row => {
  const [dept, contact] = config.DEPARTMENT_MAP[label] ?? ["미지정", "-"];
  return { label, korean: config.LABELS[label] ?? label, department: dept, contact };
});

export const collect_quotes = tool({
  name: "collect_quotes",
  description: "해당 유형의 민원 원문을 최근 순으로 가져온다. 인용할 후보다.",
  properties: {
    label: { type: "string", enum: Object.keys(config.LABELS) },
    limit: { type: "integer", description: "최대 건수 (기본 15)" },
  },
  required: ["label"],
  params: ["label", "limit"],
}, async (label: string, limit = 15): Promise<Row[]> => {
  const conn = await db.connect();
  const rows = (await conn.execute(
    `SELECT f.raw_text, COALESCE(z.name, '${config.ZONE_UNKNOWN}') zone, f.ingested_at,
            c.sentiment, c.confidence
     FROM classification c
     JOIN feedback f ON f.id = c.feedback_id
     LEFT JOIN zone z ON z.id = f.zone_id
     WHERE c.label=? AND c.status='done' AND f.deleted_at IS NULL
     ORDER BY f.id DESC LIMIT ?`, [label, limit])).fetchall();
  return rows.map((r) => ({ ...r }));
});

const _CURRENT = { basis: "" };     // 지금 만드는 요청서의 판정 근거(말). generate_doc 이 모델이 준 값 대신 쓴다

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd_hm = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const stamp_of = (d: Date) => `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

/** "a\nb\n" → 줄바꿈이 있는 TextRun 목록 (python-docx 는 \n 을 줄바꿈으로 바꾼다) */
function lines_to_runs(lines: { text: string; bold?: boolean; italics?: boolean }[]): TextRun[] {
  const runs: TextRun[] = [];
  lines.forEach((ln, i) => {
    runs.push(new TextRun({ text: ln.text, bold: ln.bold, italics: ln.italics, break: i === 0 ? 0 : 1 }));
  });
  return runs;
}

export const generate_doc = tool({
  name: "generate_doc",
  description: "부서별 조치요청서 DOCX 파일을 생성한다.",
  properties: {
    label: { type: "string", enum: Object.keys(config.LABELS) },
    department: { type: "string" },
    count: { type: "integer", description: "해당 유형 민원 건수" },
    grade: { type: "string" },
    formula: { type: "string", description: "판정 근거를 말로 푼 한 문장 (등급·건수·가중 이유. 점수·계산식 금지)" },
    quotes: {
      type: "array",
      description: "인용할 민원 원문 (최대 5건)",
      items: {
        type: "object",
        properties: { raw_text: { type: "string" }, zone: { type: "string" }, ingested_at: { type: "string" } },
        required: ["raw_text"],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: "array",
      description: "즉시 실행 가능한 조치 제안 2~4개 (관제 카드의 조치가 있으면 그대로)",
      items: { type: "string" },
    },
    festival_info: { type: "string", description: "축제 공식 정보 한 줄. 없으면 빈 문자열" },
  },
  required: ["label", "department", "count", "grade", "quotes", "suggestions"],
  params: ["label", "department", "count", "grade", "quotes", "suggestions", "formula", "festival_info"],
}, async (label: string, department: string, count: number, grade: string, quotes: Row[], suggestions: string[],
          formula = "", festival_info = ""): Promise<Row> => {
  mkdirSync(paths.OUT_DIR, { recursive: true });
  const korean = config.LABELS[label] ?? label;
  // 판정 근거는 코드가 만든 말(run_for 가 정한 것)을 쓴다. 모델이 채운 값은 점수·계산식이 섞였으면 버린다.
  const basis = _CURRENT.basis || (issues.score_leak(formula) ? "" : formula);
  const grade_ko = ({ immediate: "즉시 조치", high: "높음", mid: "보통", low: "낮음" } as Record<string, string>)[grade] ?? grade;

  const conn = await db.connect();
  const fest = (await conn.execute("SELECT name FROM festival LIMIT 1")).fetchone();
  const contact = (config.DEPARTMENT_MAP[label] ?? ["", "-"])[1];          // 연락처는 모델이 아니라 매핑표에서 채운다
  const now = new Date();

  const head_lines = [
    { text: `${fest ? fest.name : ""}`, bold: true },
    { text: `수신: ${department}` + (contact && contact !== "-" ? ` (${contact})` : "") },
    { text: "작성: 실시간 민원 관제 AI Agent" },
    { text: `일시: ${ymd_hm(now)}` },
  ];
  if (festival_info) head_lines.push({ text: `${festival_info}`, italics: true } as any);

  const rows: [string, string][] = [
    ["민원 유형", korean],
    ["접수 건수", `${count}건`],
    ["심각도", grade_ko],                          // 점수는 사람에게 보이지 않는다 (내부 계산용)
    ["판정 근거", basis || "-"],
  ];
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([k, v]) => new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun(k)] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun(String(v))] })] }),
      ],
    })),
  });

  const quote_paras = quotes.slice(0, 5).map((q) => {
    let meta = `  — ${q.zone || "구역 미상"}`;
    if (q.ingested_at) meta += `, ${String(q.ingested_at).slice(11, 16)}`;
    return new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun(`“${q.raw_text ?? ""}”`), new TextRun({ text: meta, size: 18 })],    // 9pt
    });
  });
  const sugg_paras = suggestions.slice(0, 4).map((s) => new Paragraph({ numbering: { reference: "num", level: 0 }, children: [new TextRun(s)] }));

  const doc = new Document({
    numbering: {
      config: [{
        reference: "num",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }],
      }],
    },
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("축제 민원 조치요청서")] }),
        new Paragraph({ children: lines_to_runs(head_lines) }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("1. 요청 사유")] }),
        table,
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("2. 접수된 민원 (원문 인용)")] }),
        ...quote_paras,
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("3. 조치 제안")] }),
        ...sugg_paras,
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("4. 비고")] }),
        new Paragraph({
          children: [new TextRun(
            "본 문서는 실시간 민원 관제 AI Agent가 자동 생성했습니다. " +
            "심각도는 검증된 계산 함수가 산출하며, 동일 입력에 동일 결과가 나옵니다. " +
            "민원 원문에서 개인정보는 접수 시점에 자동 마스킹되었습니다.",
          )],
        }),
      ],
    }],
  });

  // 라벨에 '/'가 들어간다("안내/동선"). 파일명에 쓰면 경로로 해석되므로 정리한다.
  // 같은 초에 같은 부서·유형 요청서를 두 번 만들면 파일이 덮어써졌다 → 밀리초를 붙이고, 그래도 같은 이름이면 -2, -3 (D5-52)
  const stamp = `${stamp_of(now)}_${String(now.getMilliseconds()).padStart(3, "0")}`;
  const base = `조치요청서_${_safe(department)}_${_safe(korean)}_${stamp}`;
  let file = path.join(paths.OUT_DIR, `${base}.docx`);
  for (let n = 2; existsSync(file); n++) file = path.join(paths.OUT_DIR, `${base}-${n}.docx`);
  writeFileSync(file, await Packer.toBuffer(doc));

  // 웹 화면이 DOCX 를 열지 않고도 같은 내용을 미리 볼 수 있게 한 벌 더 남긴다.
  const preview = {
    festival: fest ? fest.name : "",
    department, contact,
    created_at: ymd_hm(now),
    festival_info,
    label, label_ko: korean, count,
    grade, grade_ko, basis,
    quotes: quotes.slice(0, 5).map((q) => ({ raw_text: q.raw_text ?? "", zone: q.zone || "", time: String(q.ingested_at ?? "").slice(11, 16) })),
    suggestions: suggestions.slice(0, 4),
  };
  const url = await _upload(file, `${label}_${stamp}.docx`);

  // 같은 유형의 열린 이전 요청서는 새 요청서로 대체된다 (완료 건은 그대로)
  await conn.execute(
    `UPDATE action_request SET status='superseded', closed_at=? WHERE label=? AND ${db.OPEN_ACTION_SQL}`,
    [db.now(), label]);
  const cur = await conn.execute(
    `INSERT INTO action_request
     (festival_id, label, department, count, doc_path, status, created_at,
      doc_url, doc_json)
     VALUES (?,?,?,?,?, 'requested', ?, ?, ?)`,
    [await db.festival_id(), label, department, count, file, db.now(), url, JSON.stringify(preview)]);
  await conn.commit();

  return { action_id: cur.lastrowid, path: file, quotes_used: quotes.slice(0, 5).length };
});

/**
 * Supabase Storage 에 올리고 공개 URL 을 돌려준다. 실패하면 null.
 * 운영 DB(Postgres)에 붙어 있을 때만 올린다 — DB 가 SQLite 이면 SUPABASE_URL·SERVICE_KEY 가 환경에 남아 있어도 올리지 않는다
 * (테스트·측정이 DB 만 임시로 바꾸고 Storage 는 운영에 그대로 붙어 테스트 DOCX 가 운영 Storage 에 쌓인 사고, D5-57).
 * 올리지 않으면 local 대역(webapi)이 서빙하는 URL 을 돌려준다.
 */
export async function _upload(file: string, key: string): Promise<string | null> {
  if (!(db.is_pg() && config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY)) {
    return `/api/docs/${encodeURIComponent(path.basename(file))}`;
  }
  // Storage 키는 ASCII 로 둔다. 한글 파일명은 인코딩 문제로 실패하는 경우가 있다.
  const obj = `${config.SUPABASE_BUCKET}/${key}`;
  try {
    const resp = await fetch(`${config.SUPABASE_URL}/storage/v1/object/${obj}`, {
      method: "POST",
      body: readFileSync(file),
      headers: {
        Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`,
        apikey: config.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "x-upsert": "true",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await resp.arrayBuffer();
  } catch (e) {
    await db.log_agent("dispatcher", "upload_failed", "", String((e as Error).message));
    return null;
  }
  return `${config.SUPABASE_URL}/storage/v1/object/public/${obj}`;
}

/** local 대역 — 구역이 겹치지 않게 인용을 고르고 템플릿 제안을 쓴다. 제출본 아님. */
async function local_run(agent: Agent, _user_input: string, ctx: Row): Promise<string> {
  const label = ctx.label;
  const dept: Row = await agent.call("get_department", { label });
  const quotes: Row[] = await agent.call("collect_quotes", { label, limit: 15 });
  const picked = rules.pick_quotes(quotes, 5);

  const info: Row | null = await agent.call("lookup_festival_info", { keyword: ctx.festival_keyword ?? "" });
  let line = "";
  if (info) line = `${info.title ?? ""} · ${info.period ?? ""} · ${info.addr ?? ""}`;

  const res: Row = await agent.call("generate_doc", {
    label, department: dept.department, count: ctx.count,
    grade: ctx.grade, formula: ctx.basis ?? "",
    quotes: picked, suggestions: ctx.card_actions?.length ? ctx.card_actions : rules.suggestions_for(label),
    festival_info: line,
  });
  return `${dept.department} 조치요청서 생성 (인용 ${res.quotes_used}건) — ${res.path}  (local 대역)`;
}

export const dispatcher = new Agent({
  name: "dispatcher",
  system: SYSTEM,
  tools: [get_department, collect_quotes, lookup_festival_info, generate_doc],
  max_steps: 10,
  max_tokens: 8192,
  local: local_run,
});

/** 특정 유형에 대해 조치요청서를 만든다. 건수는 심각도를 판정한 창과 같은 구간에서 센다. */
export async function run_for(label: string, _score: number, grade: string, formula = "",
                              window_min: number = config.DEFAULT_WINDOW_MIN): Promise<string> {
  const korean = config.LABELS[label] ?? label;
  const cnt = (await db.label_counts(window_min))[label] ?? 0;
  const conn = await db.connect();
  const fest = (await conn.execute("SELECT name FROM festival LIMIT 1")).fetchone();
  // 건수·축제명은 모델이 도구로 알아낼 수 없다. 요청문에 직접 넣어야 generate_doc 의 count 를 채운다.
  const fest_name = fest ? fest.name : "";
  const basis = severity.basis_ko(grade, cnt, formula);           // 점수·계산식 대신 말로 푼 판정 근거
  _CURRENT.basis = basis;
  // 관제 카드에서 AI 가 근거 민원을 읽고 정리한 조치 — 요청서와 관제 화면의 조치가 같게 넘긴다
  const card_actions = await issues.actions_for_label(label);
  const card_line = card_actions.length ? "\n관제 카드의 조치(제안에 이 문장을 그대로 써라): " + card_actions.join(" / ") : "";
  return dispatcher.run(
    `'${korean}'(${label}) 유형의 심각도 등급은 ${config.GRADE_KO[grade] ?? grade}이다. ` +
    `판정 근거: ${basis}\n` +
    `같은 구간(최근 ${window_min}분)의 접수 건수는 ${cnt}건이다. ` +
    `축제: ${fest_name || "미상"}\n` +
    `담당 부서용 조치요청서를 만들어줘.${card_line}`,
    { label, grade, basis, count: cnt, festival_keyword: (fest ? fest.name : "").slice(0, 4), card_actions },
  );
}

/** 조치요청서가 아직 없는 심각 유형을 찾는다. */
export async function pending_labels(min_grade: string[] = ["immediate", "high"]): Promise<Row[]> {
  const ranked = await db.ranked();
  const out: Row[] = [];
  const conn = await db.connect();
  for (const r of ranked) {
    if (!min_grade.includes(r.grade)) continue;
    const exists = (await conn.execute(`SELECT id FROM action_request WHERE label=? AND ${db.OPEN_ACTION_SQL}`, [r.label])).fetchone();
    if (!exists) out.push(r);
  }
  return out;
}
