// 연습 서버는 연결을 하나씩 순서대로 처리하고 수신 중 유휴 제한이 없다.
// 그래서 서버로 가는 모든 일(요청·평가)을 한 줄로 세운다. 대기가 너무 길면 거절한다.
export class QueueFullError extends Error {
  constructor(message) { super(message); this.name = "QueueFullError"; }
}

export function createQueue({ maxWaiting = 8 } = {}) {
  let tail = Promise.resolve();
  let running = 0;
  let waiting = 0;
  return {
    get waiting() { return waiting; },
    get running() { return running; },
    run(task) {
      if (waiting >= maxWaiting) return Promise.reject(new QueueFullError(`대기 중인 요청이 ${waiting}개라 더 받지 않습니다.`));
      waiting += 1;
      const result = tail.then(async () => {
        waiting -= 1;
        running += 1;
        try { return await task(); } finally { running -= 1; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}
