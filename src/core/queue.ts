/** 코덱 큐 백프레셔 대기. dequeue 이벤트 또는 50ms 중 먼저 오는 쪽까지 대기해
 *  이벤트가 발화하지 않는 브라우저에서도 진행을 보장한다. */
export function waitDequeue(target: EventTarget): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener('dequeue', finish);
      resolve();
    };
    const timer = setTimeout(finish, 50);
    target.addEventListener('dequeue', finish, { once: true });
  });
}
