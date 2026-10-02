// 설정 (D5-90) — 축제 정보 · 구역 · 담당 부서. 보기만 할 때는 운영자 코드가 필요 없고, 저장할 때 코드 창이 뜬다(api 가 gateAdmin 으로 감싸져 있다).
//   · 축제 이름을 저장하면 사이드바·헤더의 이름이 바로 바뀐다 ('festival-changed' 이벤트 → main.ts).
//   · 구역은 지우지 않고 숨긴다 (민원이 있는 구역도). 숨긴 구역은 방문객 구역 선택에서 빠진다 — 서버가 /api/zones 에서 거른다.
//   · 담당 부서의 연락처가 기본 예시 번호(055-000-NNNN)인 동안은 '(예시 번호)'로 표시한다.
import "./settings.css";
import { AdminCancelled, AdminDenied } from "../admin";
import { api, type Settings } from "../data";
import { esc } from "../ui";
import { isExampleNumber } from "./contact";

export async function renderSettings(root: HTMLElement): Promise<void> {
  let s: Settings;
  try { s = await api.getSettings(); }
  catch (e) { root.innerHTML = `<section class="card"><p class="err">설정을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p></section>`; console.error(e); return; }

  root.innerHTML = `
    <p class="set-msg" id="set-msg" role="status" aria-live="polite"></p>
    <section class="card set-card" aria-labelledby="set-h-fest">
      <h2 id="set-h-fest">축제 정보</h2>
      <form class="set-form" id="set-fest">
        <label><span>이름</span><input name="name" type="text" value="${esc(s.festival.name)}" required maxlength="60" /></label>
        <label><span>지역</span><input name="region" type="text" value="${esc(s.festival.region)}" maxlength="60" /></label>
        <label><span>시작일</span><input name="start_date" type="date" value="${esc(s.festival.start_date)}" /></label>
        <label><span>종료일</span><input name="end_date" type="date" value="${esc(s.festival.end_date)}" /></label>
        <div class="set-actions"><button type="submit" class="btn primary">저장</button><span class="muted small">저장하면 사이드바와 헤더의 이름이 바로 바뀝니다</span></div>
      </form>
    </section>

    <section class="card set-card" aria-labelledby="set-h-zone">
      <h2 id="set-h-zone">구역</h2>
      <p class="muted small">민원이 있는 구역은 지우지 않고 숨깁니다. 숨긴 구역은 방문객의 구역 선택에서 빠집니다.</p>
      <ul class="set-list" id="set-zones">${s.zones.map((z) => `
        <li class="set-row${z.hidden ? " is-hidden" : ""}" data-zone="${z.id}">
          <input class="set-zname" type="text" value="${esc(z.name)}" aria-label="구역 이름 (${esc(z.name)})" maxlength="40" />
          <span class="set-count muted small">민원 ${z.feedback_count}건</span>${z.hidden ? `<span class="set-tag">숨김</span>` : ""}
          <button type="button" class="btn" data-act="rename">이름 바꾸기</button>
          <button type="button" class="btn" data-act="${z.hidden ? "show" : "hide"}">${z.hidden ? "다시 보이기" : "숨기기"}</button>
        </li>`).join("")}</ul>
      <form class="set-add" id="set-zone-add"><input name="name" type="text" placeholder="새 구역 이름" aria-label="새 구역 이름" maxlength="40" required />
        <button type="submit" class="btn">구역 추가</button></form>
    </section>

    <section class="card set-card" aria-labelledby="set-h-dept">
      <h2 id="set-h-dept">담당 부서</h2>
      <p class="muted small">유형마다 부서 이름과 연락처. <b>(예시 번호)</b>가 붙은 번호는 기본 예시라 전화 링크가 걸리지 않습니다 — 실제 번호로 바꾸면 걸립니다.</p>
      <ul class="set-list" id="set-depts">${s.departments.map((d) => `
        <li class="set-row" data-label="${esc(d.label)}">
          <b class="set-lab">${esc(d.label_ko)}</b>
          <input class="set-dept" type="text" value="${esc(d.department)}" aria-label="${esc(d.label_ko)} 담당 부서" maxlength="40" />
          <input class="set-contact" type="text" value="${esc(d.contact)}" aria-label="${esc(d.label_ko)} 연락처" inputmode="tel" maxlength="30" />
          ${isExampleNumber(d.contact) ? `<span class="ex-num">(예시 번호)</span>` : ""}
          <button type="button" class="btn" data-act="save-dept">저장</button>
        </li>`).join("")}</ul>
    </section>`;

  const msg = root.querySelector<HTMLElement>("#set-msg")!;
  const say = (t: string, bad = false) => { msg.textContent = t; msg.classList.toggle("err", bad); };

  /** 저장 한 번: 코드 창은 api 가 띄운다. 취소·거부는 조용히 알리고, 서버가 준 오류 문구는 그대로 보여 준다. */
  async function save(run: () => Promise<unknown>, done: string, festival = false): Promise<void> {
    try {
      await run();
    } catch (e) {
      if (e instanceof AdminCancelled) { say("저장을 취소했습니다"); return; }
      say(e instanceof AdminDenied ? e.message : (e as Error).message || "저장하지 못했습니다", true);
      return;
    }
    if (festival) window.dispatchEvent(new Event("festival-changed"));
    await renderSettings(root);                                   // 저장된 값으로 다시 그린다
    root.querySelector<HTMLElement>("#set-msg")!.textContent = done;
  }

  root.querySelector<HTMLFormElement>("#set-fest")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    void save(() => api.saveFestival({ name: String(f.get("name")).trim(), region: String(f.get("region")).trim(), start_date: String(f.get("start_date")), end_date: String(f.get("end_date")) }), "축제 정보를 저장했습니다", true);
  });
  root.querySelector<HTMLFormElement>("#set-zone-add")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget as HTMLFormElement).get("name")).trim();
    void save(() => api.addZone(name), `구역 '${name}' 을 추가했습니다`);
  });
  root.querySelector("#set-zones")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    const row = b?.closest<HTMLElement>("[data-zone]");
    if (!b || !row) return;
    const id = Number(row.dataset.zone);
    if (b.dataset.act === "rename") {
      const name = row.querySelector<HTMLInputElement>(".set-zname")!.value.trim();
      void save(() => api.renameZone(id, name), "구역 이름을 바꿨습니다");
    } else {
      void save(() => api.setZoneHidden(id, b.dataset.act === "hide"), b.dataset.act === "hide" ? "구역을 숨겼습니다" : "구역을 다시 보이게 했습니다");
    }
  });
  root.querySelector("#set-depts")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act='save-dept']");
    const row = b?.closest<HTMLElement>("[data-label]");
    if (!b || !row) return;
    const dept = row.querySelector<HTMLInputElement>(".set-dept")!.value.trim();
    const contact = row.querySelector<HTMLInputElement>(".set-contact")!.value.trim();
    void save(() => api.saveDepartment(row.dataset.label!, dept, contact), "담당 부서를 저장했습니다");
  });
}
