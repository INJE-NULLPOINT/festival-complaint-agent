// Python 의 KeyError · ValueError 대응 — 호출한 쪽이 instanceof 로 구분한다 (core/review.py 등이 던진다).
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
