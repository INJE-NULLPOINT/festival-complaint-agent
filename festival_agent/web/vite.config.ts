import { defineConfig } from "vite";

// local 대역(python webapi.py)으로 /api 를 넘긴다. Supabase 모드에서는 쓰이지 않는다.
// WEBAPI_PORT 로 다른 webapi 에 붙일 수 있다 (예: 테스트용 복사본 DB).
const port = process.env.WEBAPI_PORT ?? "8765";
// xfwd: true — 요청마다 X-Forwarded-For(접속자 주소)를 붙인다. 없으면 폰으로 들어온 요청도 webapi 에는 전부 127.0.0.1 로 보여
// 운영자 코드 잠금(틀린 횟수)이 출처별이 아니라 전체 공용이 된다 (D5-40). webapi 는 접속자가 루프백일 때만 이 헤더를 믿는다.
const proxy = { "/api": { target: `http://127.0.0.1:${port}`, xfwd: true } };

export default defineConfig({
  server: { proxy },
  // `npm run phone` (빌드 후 preview) 도 개발 서버와 같은 프록시를 쓴다
  preview: { proxy },
  build: {
    // 구형 폰(오래된 삼성 인터넷·Chrome)은 ??= · ?. 같은 문법 하나만 못 읽어도 스크립트 전체가 멈춰
    // CSS 없는 뼈대 HTML 만 보인다 (D5-27). 번들(의존성 포함)을 이 수준으로 낮춰 만든다.
    // vite dev 는 문법을 낮추지 않으므로 폰 확인은 `npm run phone` (빌드본) 으로 한다.
    target: ["es2017", "chrome64", "safari12"],
    // 빌드본은 CSS 를 별도 파일(<link>)로 내보낸다 → JS 가 실패해도 뼈대 대신 스타일은 적용된다
    cssTarget: ["chrome64", "safari12"],
  },
});
