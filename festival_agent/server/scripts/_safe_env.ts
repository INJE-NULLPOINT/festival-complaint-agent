// 스크립트 맨 위에서 **가장 먼저** import 한다: `import "./_safe_env.ts";`
// 측정·시연 스크립트가 실수로 운영 Supabase 에 붙지 않게, config.ts 가 읽기 전에 운영 연결 값을 빈 값으로 고정한다.
// (process.env 에 빈 문자열이라도 있으면 dotenv 가 .env 로 덮지 않는다 — server/README.md.)
// `--live-db` 를 준 때만 .env 의 운영 값을 그대로 둔다. 값은 출력하지 않는다.
export const LIVE_DB: boolean = process.argv.includes("--live-db");

if (!LIVE_DB) {
  process.env.SUPABASE_DB_URL = "";
  process.env.SUPABASE_URL = "";
  process.env.SUPABASE_SERVICE_KEY = "";
}
process.env.PYTHONIOENCODING = "utf-8";
