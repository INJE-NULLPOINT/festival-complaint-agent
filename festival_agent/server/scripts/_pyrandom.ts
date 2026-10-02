// Python random.Random(seed) 와 같은 수열 — make_dev_seed·measure_accuracy·latency_check 가 고정 시드를 쓰므로
// Python 과 같은 표본·같은 합성 민원이 나와야 결과를 비교할 수 있다 (MT19937 + Python 3.13 의 _randbelow·choices·shuffle·sample).
// 정수 시드만 지원한다 (Python 도 int 시드는 init_by_array 로 섞는다).

export class Random {
  private mt = new Uint32Array(624);
  private idx = 624;

  constructor(seed: number) {
    // Python: abs(seed) 를 32비트 조각(낮은 자리 먼저)으로 나눈 배열로 init_by_array. 0 이면 [0].
    let n = BigInt(Math.abs(Math.trunc(seed)));
    const key: number[] = [];
    if (n === 0n) key.push(0);
    while (n > 0n) { key.push(Number(n & 0xffffffffn)); n >>= 32n; }
    this.init_by_array(key);
  }

  private init_genrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    this.idx = 624;
  }

  private init_by_array(key: number[]): void {
    const mt = this.mt;
    this.init_genrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.idx = 624;
  }

  private genrand_uint32(): number {
    const mt = this.mt;
    if (this.idx >= 624) {
      let kk = 0;
      const mix = (a: number, b: number): number => ((a & 0x80000000) | (b & 0x7fffffff)) >>> 0;
      for (; kk < 624 - 397; kk++) { const y = mix(mt[kk], mt[kk + 1]); mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0); }
      for (; kk < 623; kk++) { const y = mix(mt[kk], mt[kk + 1]); mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0); }
      { const y = mix(mt[623], mt[0]); mt[623] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0); }
      this.idx = 0;
    }
    let y = mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random() */
  random(): number {
    const a = this.genrand_uint32() >>> 5, b = this.genrand_uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** random.getrandbits(k) — k 가 32 를 넘으면 BigInt 로 이어 붙인다(결과는 number, 2^53 이하만 안전) */
  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k <= 32) return this.genrand_uint32() >>> (32 - k);
    let x = 0n, shift = 0n, left = k;
    while (left > 0) {
      let r = this.genrand_uint32();
      if (left < 32) r >>>= 32 - left;
      x |= BigInt(r) << shift;
      shift += 32n; left -= 32;
    }
    return Number(x);
  }

  /** random._randbelow(n) */
  _randbelow(n: number): number {
    if (!n) return 0;
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(a: number, b: number): number { return a + this._randbelow(b - a); }
  randint(a: number, b: number): number { return this.randrange(a, b + 1); }
  uniform(a: number, b: number): number { return a + (b - a) * this.random(); }
  choice<T>(seq: readonly T[]): T { return seq[this._randbelow(seq.length)]; }

  /** random.choices(population, weights, k) */
  choices<T>(population: readonly T[], weights: readonly number[], k = 1): T[] {
    const cum: number[] = [];
    let acc = 0;
    for (const w of weights) { acc += w; cum.push(acc); }
    const total = cum[cum.length - 1] + 0.0;
    const hi = population.length - 1;
    const out: T[] = [];
    for (let i = 0; i < k; i++) {
      const x = this.random() * total;
      let lo = 0, h = hi;                      // bisect_right(cum, x, 0, hi)
      while (lo < h) { const mid = (lo + h) >> 1; if (x < cum[mid]) h = mid; else lo = mid + 1; }
      out.push(population[lo]);
    }
    return out;
  }

  /** random.shuffle(x) — 제자리 */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this._randbelow(i + 1);
      [x[i], x[j]] = [x[j], x[i]];
    }
  }

  /** random.sample(population, k) */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!(k >= 0 && k <= n)) throw new Error("Sample larger than population or is negative");
    const result: T[] = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this._randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this._randbelow(n);
        while (selected.has(j)) j = this._randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}
