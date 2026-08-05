/**
 * scrim 커스텀 룰: src/ 전역에서 네트워크 API 사용 금지.
 *
 * 금지 대상: fetch, XMLHttpRequest, WebSocket, EventSource, navigator.sendBeacon
 * 유일한 예외는 src/core/assets.ts이며, 그 파일에서도 fetch의 첫 인자가
 * '/models/'로 시작하는 문자열 리터럴일 때만 허용한다.
 *
 * 이 룰은 "업로드 없음"을 코드 수준에서 검증 가능하게 만드는 장치다.
 */
const BANNED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'src/ 안에서 네트워크 API 사용을 금지한다 (개인정보 보장)',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowModelFetch: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned: "'{{name}}' 사용 금지 — 이 앱은 네트워크 요청을 하지 않는다 (src/core/assets.ts만 예외).",
      badModelPath: "assets.ts의 fetch는 '/models/'로 시작하는 리터럴 경로만 허용한다.",
    },
  },
  create(context) {
    const allowModelFetch = context.options[0]?.allowModelFetch === true;

    function isGlobalReference(node) {
      const scope = context.sourceCode.getScope(node);
      const ref = scope.references.find((r) => r.identifier === node);
      // 스코프 체인에서 해석되지 않으면(=선언 없음) 전역 참조다
      if (ref) return ref.resolved === null || ref.resolved.defs.length === 0;
      return true;
    }

    return {
      Identifier(node) {
        if (!BANNED_GLOBALS.has(node.name)) return;
        // 선언/프로퍼티 키 위치는 제외
        const parent = node.parent;
        if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (!isGlobalReference(node)) return;

        if (node.name === 'fetch' && allowModelFetch) {
          const call = parent.type === 'CallExpression' && parent.callee === node ? parent : null;
          if (call) {
            const arg = call.arguments[0];
            const ok =
              arg &&
              ((arg.type === 'Literal' && typeof arg.value === 'string' && arg.value.startsWith('/models/')) ||
                (arg.type === 'TemplateLiteral' &&
                  arg.quasis[0] &&
                  arg.quasis[0].value.cooked?.startsWith('/models/')));
            if (ok) return;
            context.report({ node, messageId: 'badModelPath' });
            return;
          }
        }
        context.report({ node, messageId: 'banned', data: { name: node.name } });
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.property.type === 'Identifier' &&
          node.property.name === 'sendBeacon' &&
          node.object.type === 'Identifier' &&
          node.object.name === 'navigator'
        ) {
          context.report({ node, messageId: 'banned', data: { name: 'navigator.sendBeacon' } });
        }
      },
    };
  },
};
