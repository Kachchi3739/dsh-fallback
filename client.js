window.__ModuleLoader__.load({
  id: 'dsh-fallback',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // -------------------------------------------------------------------
    // Router fallback — Settings page
    //
    // One page in the Settings shell. It talks to the Host half through
    // same-origin JSON routes under /dsh-fallback, loads the routers that are
    // already connected to this Harness profile, and edits the fallback chain.
    // No shipped client package is imported: controls are plain React
    // elements styled only with the host's --dsw-alias-* theme tokens.
    // -------------------------------------------------------------------

    const NS = 'dsh-fallback.settings'
    const API = '/dsh-fallback'
    const POLL_MS = 12000

    const TRIGGER_CODES = [
      'QUOTA',
      'ACCOUNT_QUOTA',
      'RATE_LIMIT',
      'AUTH',
      'INVALID_CREDENTIAL',
      'MISSING_CREDENTIAL',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
    ]

    const CODE_LABELS = {
      QUOTA: 'quota exhausted',
      ACCOUNT_QUOTA: 'account quota',
      RATE_LIMIT: 'rate limit',
      AUTH: 'authentication',
      INVALID_CREDENTIAL: 'invalid credential',
      MISSING_CREDENTIAL: 'missing credential',
      SERVER: 'server error',
      TIMEOUT: 'timeout',
      TRANSPORT: 'transport',
    }

    const COPY = {
      en: {
        nav: 'Router fallback',
        title: 'Router fallback',
        subtitle:
          'When the active router reports an exhausted quota or limit, the same request continues on the next router in this chain. Routers are loaded from this Harness profile, so they already have their credentials and endpoints.',
        enabled: 'Enable router fallback',
        enabledHint: 'Off leaves every request on the router you selected in the composer.',
        on: 'On',
        off: 'Off',
        chainTitle: 'Fallback chain',
        chainHint:
          'A request starts on the router you selected, then continues down this list. Order matters: the first ready router answers.',
        chainEmpty: 'The chain is empty. Add one of the connected routers below.',
        addTitle: 'Connected routers',
        addHint: 'Already connected to this Harness profile — no key or endpoint to re-enter.',
        add: 'Add',
        inChain: 'In chain',
        inheritModel: 'Use the selected model',
        model: 'Model',
        noModels: 'no model catalog reported',
        moveUp: 'Move up',
        moveDown: 'Move down',
        remove: 'Remove',
        codesTitle: 'Trigger codes',
        codesHint: 'A failure with one of these codes moves the request to the next router.',
        maxAttempts: 'Max attempts per request',
        cooldownTitle: 'Skip duration after an exhausted response',
        cooldownQuota: 'Quota / balance (minutes)',
        cooldownRate: 'Rate limit (seconds)',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        reset: 'Reset to bundle defaults',
        resetConfirm: 'Reset every fallback setting to the bundle default?',
        test: 'Test fallback',
        testing: 'Testing…',
        testTitle: 'Fallback test',
        testAnswered: 'answered by',
        testFailed: 'no router answered',
        testProbe: 'probe',
        testAttempts: 'Attempts',
        healthTitle: 'Router status',
        healthReady: 'ready',
        healthCooling: 'cooling down',
        healthReset: 'Reset cooldowns',
        healthEmpty: 'No router connected yet.',
        eventsTitle: 'Recent fallback events',
        eventsEmpty: 'No fallback has been used yet.',
        clear: 'Clear',
        refresh: 'Refresh',
        updated: 'updated',
        storageWarning: 'The profile state file is not writable, so changes last until restart:',
        configurableTitle: 'Declared but not connected',
        configurableHint: 'Add credentials for these routes in Settings → Models to make them usable here.',
        errorPrefix: 'Router fallback:',
        chainNeedsModel: 'Pick a model for every chain row before saving.',
        disabledWarning: 'Fallback is off, so requests do not move to the next router.',
        testNeedsChain: 'Add at least one router to the chain, then run the test.',
        testHint:
          'Sends one tiny request through a simulated exhausted router. The first real router in the chain that answers proves the path works.',
        dirty: 'Unsaved changes',
        attempts: 'attempts',
        seconds: 's',
        minutes: 'min',
        none: 'none',
        summary: 'Answering router',
        accountsTitle: 'opencode-go accounts',
        accountsHint:
          'Connect several API keys (accounts) to the same opencode-go router. The plugin rotates them for every DSH request — even when router fallback is off — and only moves down the fallback chain after the accounts fail. The first (default) account uses the key configured in Settings → Models.',
        accountModeLabel: 'Account usage',
        accountModeRotate: 'Rotate per request',
        accountModeSticky: 'Sticky per session',
        accountModeFailover: 'Priority (failover)',
        accountModeRotateHint: 'Every request starts with the next healthy account, so all keys share the load.',
        accountModeStickyHint: 'Each session keeps one account for prompt-cache reuse; a new session takes the next account.',
        accountModeFailoverHint: 'The first account is used until it fails; the next account takes over only then.',
        accountModeApplies: 'Applies to every DSH request on this router, even with router fallback off.',
        accountDefault: 'default account',
        accountDefaultHint: 'uses the key from Settings → Models',
        accountAdded: 'added account',
        accountKeyPresent: 'key stored',
        accountKeyMissing: 'key missing',
        accountAddLabel: 'Label',
        accountAddLabelPlaceholder: 'e.g. account 2',
        accountAddKey: 'API key',
        accountAddKeyPlaceholder: 'paste the opencode-go key',
        accountAdd: 'Add account',
        accountAdding: 'Adding…',
        accountRemove: 'Remove',
        accountTest: 'Test',
        accountTesting: 'Testing…',
        accountSkip: 'Skip 30 min',
        accountResume: 'Resume',
        accountModel: 'model:',
        accountTestOk: 'answered',
        accountTestFailed: 'failed',
        accountNeedsKey: 'Enter the account API key.',
        accountRotationTest: 'Test rotation',
        accountRotationTesting: 'Testing rotation…',
        accountRotationResult: 'Account distribution',
        accountRotationFailed: 'some test requests failed',
        accountRequests: 'requests',
        accountSuccesses: 'successes',
        accountSupportsHint:
          'Rotation uses the pi-ai header waterfall; keys stay in the Harness credentials store, never in configuration or the state file.',
        accountsUnavailable: 'The credentials service is unavailable in this profile, so accounts cannot be stored.',
        accountEmpty: 'Only the default account is in use.',
        accountsChainHint: 'These accounts serve this router everywhere in DSH, including as a fallback target.',
      },
      ko: {
        nav: '라우터 폴백',
        title: '라우터 폴백',
        subtitle:
          '사용 중인 라우터가 한도나 쿼터를 소진하면 같은 요청을 체인의 다음 라우터로 이어서 보냅니다. 라우터 목록은 이 DSH 프로필에 이미 연결된 것들을 그대로 불러오므로 키나 주소를 다시 입력할 필요가 없습니다.',
        enabled: '라우터 폴백 사용',
        enabledHint: '끄면 작성창에서 선택한 라우터로만 요청합니다.',
        on: '사용',
        off: '중지',
        chainTitle: '폴백 체인',
        chainHint:
          '요청은 선택한 라우터에서 시작해 아래 순서로 이어집니다. 순서가 중요하며, 먼저 정상인 라우터가 응답합니다.',
        chainEmpty: '체인이 비어 있습니다. 아래에서 연결된 라우터를 추가하세요.',
        addTitle: '연결된 라우터',
        addHint: '이 DSH 프로필에 이미 연결되어 있어 키나 주소를 다시 입력할 필요가 없습니다.',
        add: '추가',
        inChain: '체인에 포함됨',
        inheritModel: '선택한 모델 그대로 사용',
        model: '모델',
        noModels: '모델 목록 없음',
        moveUp: '위로',
        moveDown: '아래로',
        remove: '제거',
        codesTitle: '전환 트리거 코드',
        codesHint: '아래 코드로 실패하면 요청을 다음 라우터로 넘깁니다.',
        maxAttempts: '요청당 최대 시도 수',
        cooldownTitle: '한도 소진 후 건너뛸 시간',
        cooldownQuota: '쿼터·잔액 소진 (분)',
        cooldownRate: '속도 제한 (초)',
        save: '저장',
        saving: '저장 중…',
        saved: '저장했습니다.',
        reset: '번들 기본값으로 초기화',
        resetConfirm: '모든 폴백 설정을 번들 기본값으로 되돌릴까요?',
        test: '폴백 테스트',
        testing: '테스트 중…',
        testTitle: '폴백 테스트',
        testAnswered: '응답한 라우터',
        testFailed: '응답한 라우터가 없습니다',
        testProbe: '가상 라우터',
        testAttempts: '시도 기록',
        healthTitle: '라우터 상태',
        healthReady: '정상',
        healthCooling: '건너뛰는 중',
        healthReset: '건너뛰기 초기화',
        healthEmpty: '아직 연결된 라우터가 없습니다.',
        eventsTitle: '최근 폴백 기록',
        eventsEmpty: '아직 폴백을 사용한 적이 없습니다.',
        clear: '비우기',
        refresh: '새로고침',
        updated: '갱신',
        storageWarning: '프로필 상태 파일에 쓸 수 없어 변경 사항은 재시작 전까지만 유지됩니다:',
        configurableTitle: '선언만 된 라우터',
        configurableHint: '설정 → 모델에서 자격 증명을 추가하면 여기서 사용할 수 있습니다.',
        errorPrefix: '라우터 폴백:',
        chainNeedsModel: '저장하기 전에 체인의 각 행에 모델을 선택하세요.',
        disabledWarning: '폴백이 꺼져 있어 다음 라우터로 넘어가지 않습니다.',
        testNeedsChain: '체인에 라우터를 하나 이상 추가한 뒤 테스트하세요.',
        testHint:
          '한도가 소진된 가상 라우터를 거쳐 아주 작은 요청을 보냅니다. 체인에서 먼저 응답한 실제 라우터가 경로가 살아 있음을 증명합니다.',
        dirty: '저장되지 않은 변경',
        attempts: '시도',
        seconds: '초',
        minutes: '분',
        none: '없음',
        summary: '응답 라우터',
        accountsTitle: 'opencode-go 계정',
        accountsHint:
          '같은 opencode-go 라우터에 여러 API 키(계정)를 연결합니다. 라우터 폴백이 꺼져 있어도 플러그인이 모든 DSH 요청에서 이 계정들을 순환 사용하고, 계정들이 실패한 뒤에야 폴백 체인의 다음 라우터로 넘어갑니다. 첫 번째(기본) 계정은 설정 → 모델에 저장된 키를 사용합니다.',
        accountModeLabel: '계정 사용 방식',
        accountModeRotate: '요청마다 순환',
        accountModeSticky: '세션마다 고정',
        accountModeFailover: '우선순위 (장애 시 전환)',
        accountModeRotateHint: '요청마다 다음 정상 계정으로 시작해 모든 키가 부하를 나눠 가집니다.',
        accountModeStickyHint: '세션마다 한 계정을 유지해 프롬프트 캐시를 재사용하고, 새 세션은 다음 계정을 사용합니다.',
        accountModeFailoverHint: '첫 계정을 우선 사용하고 실패하면 그때 다음 계정으로 넘어갑니다.',
        accountModeApplies: '라우터 폴백이 꺼져 있어도 이 라우터의 모든 DSH 요청에 적용됩니다.',
        accountDefault: '기본 계정',
        accountDefaultHint: '설정 → 모델의 키 사용',
        accountAdded: '추가 계정',
        accountKeyPresent: '키 저장됨',
        accountKeyMissing: '키 없음',
        accountAddLabel: '이름',
        accountAddLabelPlaceholder: '예: 계정 2',
        accountAddKey: 'API 키',
        accountAddKeyPlaceholder: 'opencode-go 키를 붙여넣으세요',
        accountAdd: '계정 추가',
        accountAdding: '추가 중…',
        accountRemove: '삭제',
        accountTest: '테스트',
        accountTesting: '테스트 중…',
        accountSkip: '30분 건너뛰기',
        accountResume: '다시 사용',
        accountModel: '모델:',
        accountTestOk: '응답',
        accountTestFailed: '실패',
        accountNeedsKey: '계정 API 키를 입력하세요.',
        accountRotationTest: '로테이션 테스트',
        accountRotationTesting: '로테이션 테스트 중…',
        accountRotationResult: '계정 분배 결과',
        accountRotationFailed: '일부 테스트 요청 실패',
        accountRequests: '요청',
        accountSuccesses: '성공',
        accountSupportsHint:
          '순환은 pi-ai 헤더 워터폴을 사용하며, 키는 Harness 자격 증명 저장소에만 보관됩니다(설정·상태 파일에는 남지 않음).',
        accountEmpty: '기본 계정만 사용 중입니다.',
        accountsChainHint: '이 계정들은 폴백 대상일 때를 포함해 DSH 전반에서 이 라우터를 담당합니다.',
      },
    }

    function readLocale(ctx) {
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale !== undefined && typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') return bound
        }
      } catch (error) {
        // The optional locale service must never break the page.
      }
      return (key) => COPY.en[key] ?? key
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        width: '100%',
        maxWidth: 880,
        minWidth: 0,
        margin: '0 auto',
        padding: '20px 24px 56px',
        boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: { display: 'flex', flexDirection: 'column', gap: 4 },
      h1: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.35 },
      subtitle: { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
        boxSizing: 'border-box',
      },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
      hint: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
      chainRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      chainHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      chainMeta: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' },
      chainControls: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      index: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        flex: '0 0 auto',
        borderRadius: 999,
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 11,
        fontWeight: 700,
      },
      providerName: { minWidth: 110, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      providerId: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      select: {
        flex: '1 1 auto',
        minWidth: 0,
        maxWidth: 420,
        font: 'inherit',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 6px',
      },
      input: {
        width: 92,
        font: 'inherit',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 6px',
      },
      textInput: {
        flex: '1 1 140px',
        minWidth: 0,
        font: 'inherit',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 6px',
      },
      button: {
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.5,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primaryButton: {
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.5,
        padding: '4px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        cursor: 'pointer',
        fontWeight: 600,
      },
      smallButton: {
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1.4,
        padding: '2px 7px',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: 1.6,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: 1.6,
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      okBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: 1.6,
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      errorBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: 1.6,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
      warning: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-primary)' },
      muted: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      codeGrid: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px' },
      check: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
      eventRow: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      pre: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    }

    async function request(path, init) {
      const response = await fetch(`${API}${path}`, {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init && init.headers ? init.headers : {}) },
      })
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (response.ok !== true || (body !== null && body.ok === false)) {
        const message = body && (body.message || body.error) ? body.message || body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    }

    const formatRemaining = (ms) => {
      const total = Math.max(0, Math.round(Number(ms) / 1000))
      if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
      if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`
      return `${total}s`
    }

    const formatClock = (value) => {
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch (error) {
        return String(value)
      }
    }

    const draftFromPayload = (payload) => ({
      enabled: payload.config.enabled !== false,
      chain: payload.config.chain.map((entry) => ({ provider: entry.provider, model: entry.model })),
      accountMode: payload.config.accountMode ?? 'rotate',
      fallbackCodes: payload.config.fallbackCodes.slice(),
      maxAttempts: payload.config.maxAttempts,
      cooldownQuotaMin: Math.round((payload.config.cooldowns.QUOTA ?? 1800000) / 60000),
      cooldownRateSec: Math.round((payload.config.cooldowns.RATE_LIMIT ?? 60000) / 1000),
    })

    const overridesOf = (draft) => ({
      enabled: draft.enabled,
      chain: draft.chain.map((entry) => ({ provider: entry.provider, model: entry.model })),
      accountMode: draft.accountMode,
      fallbackCodes: draft.fallbackCodes.slice(),
      maxAttempts: draft.maxAttempts,
      cooldowns: {
        QUOTA: Math.max(0, Math.round(draft.cooldownQuotaMin)) * 60000,
        ACCOUNT_QUOTA: Math.max(0, Math.round(draft.cooldownQuotaMin)) * 60000,
        RATE_LIMIT: Math.max(0, Math.round(draft.cooldownRateSec)) * 1000,
      },
    })

    function Toggle({ checked, onChange, label, hint }) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' } },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: (event) => onChange(event.target.checked),
          }),
          h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, label),
        ),
        hint === undefined ? null : h('span', { style: styles.muted }, hint),
      )
    }

    function RouterFallbackSection({ ctx }) {
      const [payload, setPayload] = useState(null)
      const [draft, setDraft] = useState(null)
      const [models, setModels] = useState({})
      const [busy, setBusy] = useState(false)
      const [busyLabel, setBusyLabel] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const [accountForm, setAccountForm] = useState({ label: '', key: '' })
      const [accountBusy, setAccountBusy] = useState(null)
      const [accountResult, setAccountResult] = useState(null)
      const [rotationResult, setRotationResult] = useState(null)
      const dirtyRef = useRef(false)

      const locale = (key) => {
        try {
          const service = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (service !== undefined && typeof service.bind === 'function') {
            const translated = service.bind(NS)(key)
            if (typeof translated === 'string' && translated.length > 0 && translated !== key) return translated
          }
        } catch (error) {
          // A shell without the optional locale service falls back to English.
        }
        return COPY.en[key] ?? key
      }

      const load = useCallback(async () => {
        const [state, modelPayload] = await Promise.all([request('/state'), request('/models')])
        setPayload(state)
        setDraft((current) => (current === null || dirtyRef.current === false ? draftFromPayload(state) : current))
        const nextModels = {}
        for (const provider of modelPayload.providers) nextModels[provider.id] = provider.models || []
        for (const provider of state.providers) {
          if (nextModels[provider.id] === undefined) nextModels[provider.id] = provider.models || []
        }
        setModels(nextModels)
      }, [])

      useEffect(() => {
        let alive = true
        load()
          .then(() => setError(null))
          .catch((loadError) => {
            if (alive) setError(loadError.message)
          })
        const timer = setInterval(() => {
          if (dirtyRef.current === true) return
          load().catch(() => {})
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const dirty = useMemo(() => {
        if (payload === null || draft === null) return false
        return JSON.stringify(overridesOf(draft)) !== JSON.stringify(overridesOf(draftFromPayload(payload)))
      }, [draft, payload])
      dirtyRef.current = dirty

      const persist = useCallback(
        async (overrides) => {
          const next = await request('/config', { method: 'POST', body: JSON.stringify({ overrides }) })
          setPayload(next)
          setDraft(draftFromPayload(next))
          setError(null)
          return next
        },
        [],
      )

      const save = useCallback(async () => {
        if (draft === null) return
        if (draft.chain.some((entry) => typeof entry.model !== 'string')) {
          setError(locale('chainNeedsModel'))
          return
        }
        setBusy(true)
        setBusyLabel('save')
        try {
          await persist(overridesOf(draft))
          setNotice(locale('saved'))
        } catch (saveError) {
          setError(saveError.message)
        } finally {
          setBusy(false)
          setBusyLabel(null)
        }
      }, [draft, locale, persist])

      const runTest = useCallback(async () => {
        if (draft === null || draft.chain.length === 0) {
          setError(locale('testNeedsChain'))
          return
        }
        setBusy(true)
        setBusyLabel('test')
        setTestResult(null)
        try {
          if (dirty) await persist(overridesOf(draft))
          const body = await request('/selftest', { method: 'POST', body: '{}' })
          setTestResult(body.result)
          setError(null)
        } catch (testError) {
          setError(testError.message)
        } finally {
          setBusy(false)
          setBusyLabel(null)
        }
      }, [dirty, draft, locale, persist])

      const resetHealth = useCallback(async () => {
        setBusy(true)
        setBusyLabel('healthReset')
        try {
          const next = await request('/health/reset', { method: 'POST', body: '{}' })
          setPayload(next)
          setError(null)
        } catch (resetError) {
          setError(resetError.message)
        } finally {
          setBusy(false)
          setBusyLabel(null)
        }
      }, [])

      const resetOverrides = useCallback(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(locale('resetConfirm')) !== true) {
          return
        }
        setBusy(true)
        setBusyLabel('reset')
        try {
          const next = await request('/overrides/reset', { method: 'POST', body: '{}' })
          setPayload(next)
          setDraft(draftFromPayload(next))
          setTestResult(null)
          setError(null)
        } catch (resetError) {
          setError(resetError.message)
        } finally {
          setBusy(false)
          setBusyLabel(null)
        }
      }, [locale])

      const clearEvents = useCallback(async () => {
        try {
          const next = await request('/events/clear', { method: 'POST', body: '{}' })
          setPayload(next)
        } catch (clearError) {
          setError(clearError.message)
        }
      }, [])

      // -----------------------------------------------------------------
      // Pooled opencode-go accounts
      // -----------------------------------------------------------------

      const accountsOf = (nextPayload, provider) =>
        (nextPayload.accounts?.providers ?? []).find((entry) => entry.provider === provider) ?? null

      const applyAccountsPayload = (accountsPayload) => {
        setPayload((current) => (current === null ? current : { ...current, accounts: accountsPayload }))
      }

      const runAccountAction = async (path, body) => {
        const result = await request(path, { method: 'POST', body: JSON.stringify(body) })
        if (result.accounts !== undefined) applyAccountsPayload(result.accounts)
        return result
      }

      const createAccount = async (provider) => {
        if (accountForm.key.trim().length === 0) {
          setError(locale('accountNeedsKey'))
          return
        }
        setAccountBusy('create')
        setError(null)
        try {
          const result = await request('/accounts/create', {
            method: 'POST',
            body: JSON.stringify({ provider, label: accountForm.label, key: accountForm.key }),
          })
          if (result.accounts !== undefined) applyAccountsPayload(result.accounts)
          setAccountForm({ label: '', key: '' })
          setNotice(locale('saved'))
        } catch (createError) {
          setError(createError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const removeAccountRow = async (provider, id, label) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (window.confirm(`${locale('accountRemove')}: ${label ?? id}?`) !== true) return
        }
        setAccountBusy(id)
        try {
          await runAccountAction('/accounts/remove', { provider, id })
          setError(null)
        } catch (removeError) {
          setError(removeError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const skipAccountRow = async (provider, id) => {
        setAccountBusy(id)
        try {
          await runAccountAction('/accounts/skip', { provider, id, minutes: 30 })
        } catch (skipError) {
          setError(skipError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const resumeAccountRow = async (provider, id) => {
        setAccountBusy(id)
        try {
          await runAccountAction('/accounts/resume', { provider, id })
        } catch (resumeError) {
          setError(resumeError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const moveAccountRow = async (provider, rows, index, direction) => {
        const target = index + direction
        if (target < 0 || target >= rows.length) return
        const ids = rows.map((row) => row.id)
        const [moved] = ids.splice(index, 1)
        ids.splice(target, 0, moved)
        setAccountBusy('order')
        try {
          await runAccountAction('/accounts/reorder', { provider, ids })
        } catch (orderError) {
          setError(orderError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const testAccountRow = async (provider, id) => {
        setAccountBusy(`test:${id}`)
        setAccountResult(null)
        try {
          const result = await request('/accounts/test', {
            method: 'POST',
            body: JSON.stringify({ provider, id }),
          })
          setAccountResult({ provider, id, ...result.result })
          setError(null)
        } catch (testError) {
          setError(testError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const changeAccountMode = async (mode) => {
        setAccountBusy('mode')
        setError(null)
        try {
          const next = await request('/config', { method: 'POST', body: JSON.stringify({ patch: { accountMode: mode } }) })
          setPayload(next)
          setDraft((current) => (current === null ? current : { ...current, accountMode: mode }))
          setRotationResult(null)
        } catch (modeError) {
          setError(modeError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const runRotationTest = async (provider) => {
        setAccountBusy('rotation')
        setRotationResult(null)
        try {
          const result = await request('/accounts/rotation-test', { method: 'POST', body: JSON.stringify({ provider }) })
          setRotationResult({ provider, ...result.result })
          const refreshed = await request('/accounts')
          applyAccountsPayload(refreshed.accounts)
          setError(null)
        } catch (rotationError) {
          setError(rotationError.message)
        } finally {
          setAccountBusy(null)
        }
      }

      const updateDraft = useCallback((mutate) => {
        setDraft((current) => {
          if (current === null) return current
          const next = {
            ...current,
            chain: current.chain.map((entry) => ({ ...entry })),
            fallbackCodes: current.fallbackCodes.slice(),
          }
          mutate(next)
          return next
        })
      }, [])

      const addProvider = (provider) => {
        const catalog = models[provider.id] || []
        const firstModel = catalog.length > 0 ? catalog[0].id : ''
        updateDraft((next) => {
          if (next.chain.some((entry) => entry.provider === provider.id)) return
          next.chain.push({ provider: provider.id, model: firstModel })
        })
        setNotice(null)
      }

      const removeAt = (index) => {
        updateDraft((next) => {
          next.chain.splice(index, 1)
        })
      }

      const move = (index, direction) => {
        updateDraft((next) => {
          const target = index + direction
          if (target < 0 || target >= next.chain.length) return
          const [row] = next.chain.splice(index, 1)
          next.chain.splice(target, 0, row)
        })
      }

      const setEntryModel = (index, model) => {
        updateDraft((next) => {
          if (next.chain[index] !== undefined) next.chain[index].model = model
        })
      }

      const toggleCode = (code) => {
        updateDraft((next) => {
          const position = next.fallbackCodes.indexOf(code)
          if (position >= 0) next.fallbackCodes.splice(position, 1)
          else next.fallbackCodes.push(code)
        })
      }

      const providers = payload === null ? [] : payload.providers
      const inChain = new Set(draft === null ? [] : draft.chain.map((entry) => entry.provider))
      const candidates = providers.filter((provider) => !inChain.has(provider.id))
      const degraded = (provider) => provider.degraded !== null && provider.degraded !== undefined
      const healthyCount = providers.filter((provider) => !degraded(provider)).length
      const coolingCount = providers.length - healthyCount
      const accountMode = payload?.accounts?.mode ?? payload?.config?.accountMode ?? 'rotate'
      const accountModeHint =
        accountMode === 'sticky'
          ? locale('accountModeStickyHint')
          : accountMode === 'failover'
            ? locale('accountModeFailoverHint')
            : locale('accountModeRotateHint')

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.header },
          h('h1', { style: styles.h1 }, locale('title')),
          h('p', { style: styles.subtitle }, locale('subtitle')),
          h(
            'div',
            { style: styles.row },
            payload === null
              ? null
              : h(
                  'span',
                  { style: draft !== null && draft.enabled === false ? styles.badBadge : styles.okBadge },
                  draft !== null && draft.enabled === false ? locale('off') : locale('on'),
                ),
            payload === null
              ? null
              : h(
                  'span',
                  { style: styles.muted },
                  `${providers.length} ${locale('addTitle').toLowerCase()} · ${healthyCount} ${locale('healthReady')} · ${coolingCount} ${locale('healthCooling')}`,
                ),
            payload === null
              ? null
              : h('span', { style: styles.muted }, `v${payload.version} · ${locale('updated')} ${formatClock(payload.now)}`),
            h(
              'button',
              {
                type: 'button',
                style: styles.smallButton,
                onClick: () => {
                  load().catch((loadError) => setError(loadError.message))
                },
                disabled: busy,
              },
              locale('refresh'),
            ),
            payload !== null && payload.storage && payload.storage.writable === false
              ? h('span', { style: styles.warning }, `${locale('storageWarning')} ${payload.storage.error || ''}`)
              : null,
          ),
        ),

        payload === null
          ? h('p', { style: styles.hint }, '…')
          : h(
              'div',
              { style: styles.card },
              h('h2', { style: styles.cardTitle }, locale('healthTitle')),
              providers.length === 0
                ? h('p', { style: styles.hint }, locale('healthEmpty'))
                : h(
                    'div',
                    { style: styles.row },
                    providers.map((provider) =>
                      h(
                        'span',
                        { key: provider.id, style: degraded(provider) ? styles.badBadge : styles.badge, title: provider.id },
                        `${provider.name} · ${
                          degraded(provider)
                            ? `${locale('healthCooling')} (${provider.degraded.code}, ${formatRemaining(provider.degraded.remainingMs)})`
                            : locale('healthReady')
                        }`,
                      ),
                    ),
                  ),
              h(
                'div',
                { style: styles.row },
                h(
                  'button',
                  { type: 'button', style: styles.smallButton, onClick: resetHealth, disabled: busy },
                  locale('healthReset'),
                ),
              ),
            ),

        payload === null || payload.accounts === undefined
          ? null
          : h(
              'div',
              { style: styles.card },
              h('h2', { style: styles.cardTitle }, locale('accountsTitle')),
              h('p', { style: styles.hint }, locale('accountsHint')),
              (payload.accounts.providers ?? []).length > 0
                ? h(
                    'div',
                    { style: styles.row },
                    h('span', { style: { fontSize: 12, fontWeight: 600 } }, locale('accountModeLabel')),
                    h(
                      'select',
                      {
                        style: styles.select,
                        value: accountMode,
                        disabled: accountBusy !== null,
                        onChange: (event) => changeAccountMode(event.target.value),
                      },
                      h('option', { value: 'rotate' }, locale('accountModeRotate')),
                      h('option', { value: 'sticky' }, locale('accountModeSticky')),
                      h('option', { value: 'failover' }, locale('accountModeFailover')),
                    ),
                    h('span', { style: styles.muted }, locale('accountModeApplies')),
                  )
                : null,
              (payload.accounts.providers ?? []).length > 0 ? h('p', { style: styles.hint }, accountModeHint) : null,
              payload.accounts.credentialsAvailable === false
                ? h('p', { style: styles.warning }, locale('accountsUnavailable'))
                : null,
              (payload.accounts.providers ?? []).map((entry) => {
                const rows = entry.accounts ?? []
                const addedRows = rows.filter((row) => row.kind === 'added')
                return h(
                  'div',
                  { key: entry.provider, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h(
                    'div',
                    { style: styles.row },
                    h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, `${entry.displayName} (${entry.provider})`),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.smallButton,
                        disabled: accountBusy !== null || rows.length < 2,
                        onClick: () => runRotationTest(entry.provider),
                      },
                      accountBusy === 'rotation' ? locale('accountRotationTesting') : locale('accountRotationTest'),
                    ),
                    h('span', { style: styles.muted }, locale('accountsChainHint')),
                  ),
                  rows.length === 1
                    ? h('p', { style: styles.hint }, locale('accountEmpty'))
                    : null,
                  rows.map((account) => {
                    const isDefault = account.kind === 'default'
                    const cooling = account.degraded !== null && account.degraded !== undefined
                    const addedIndex = addedRows.findIndex((row) => row.id === account.id)
                    const testing = accountBusy === `test:${account.id}`
                    const usage =
                      account.stats !== null && account.stats !== undefined && account.stats.requests > 0
                        ? ` · ${locale('accountRequests')} ${account.stats.requests} · ${locale('accountSuccesses')} ${account.stats.successes}`
                        : ''
                    return h(
                      'div',
                      { key: account.id, style: styles.chainRow },
                      h(
                        'div',
                        { style: styles.chainHead },
                        h('span', { style: styles.index }, isDefault ? '1' : String(addedIndex + 2)),
                        h(
                          'div',
                          { style: styles.chainMeta },
                          h('span', { style: styles.providerName }, isDefault ? locale('accountDefault') : account.label),
                          h(
                            'span',
                            { style: styles.providerId },
                            `${
                              isDefault
                                ? locale('accountDefaultHint')
                                : `${locale('accountAdded')} · ${account.keyPresent === false ? locale('accountKeyMissing') : locale('accountKeyPresent')}`
                            }${cooling ? ` · ${locale('healthCooling')} (${account.degraded.code}, ${formatRemaining(account.degraded.remainingMs)})` : ''}${usage}`,
                          ),
                        ),
                        cooling ? h('span', { style: styles.badBadge }, locale('healthCooling')) : h('span', { style: styles.okBadge }, locale('healthReady')),
                      ),
                      h(
                        'div',
                        { style: styles.chainControls },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: styles.smallButton,
                            disabled: accountBusy !== null,
                            onClick: () => testAccountRow(entry.provider, account.id),
                          },
                          testing ? locale('accountTesting') : locale('accountTest'),
                        ),
                        cooling
                          ? h(
                              'button',
                              { type: 'button', style: styles.smallButton, disabled: accountBusy !== null, onClick: () => resumeAccountRow(entry.provider, account.id) },
                              locale('accountResume'),
                            )
                          : h(
                              'button',
                              { type: 'button', style: styles.smallButton, disabled: accountBusy !== null, onClick: () => skipAccountRow(entry.provider, account.id) },
                              locale('accountSkip'),
                            ),
                        isDefault
                          ? null
                          : h(
                              'button',
                              { type: 'button', style: styles.smallButton, onClick: () => moveAccountRow(entry.provider, addedRows, addedIndex, -1), disabled: addedIndex === 0 },
                              '↑',
                            ),
                        isDefault
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                style: styles.smallButton,
                                onClick: () => moveAccountRow(entry.provider, addedRows, addedIndex, 1),
                                disabled: addedIndex === addedRows.length - 1,
                              },
                              '↓',
                            ),
                        isDefault
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                style: styles.smallButton,
                                disabled: accountBusy !== null,
                                onClick: () => removeAccountRow(entry.provider, account.id, account.label),
                              },
                              locale('accountRemove'),
                            ),
                      ),
                    )
                  }),
                  accountResult !== null && accountResult.provider === entry.provider
                    ? h(
                        'p',
                        { style: accountResult.ok === true ? styles.hint : styles.error, role: 'status' },
                        `${locale('accountModel')} ${accountResult.model} · ${
                          accountResult.ok === true
                            ? `${locale('accountTestOk')}: ${accountResult.account?.label ?? locale('accountDefault')} (${accountResult.latencyMs} ms)`
                            : `${locale('accountTestFailed')}: ${accountResult.failure?.code ?? 'ERROR'} ${accountResult.failure?.message ?? ''}`
                        }`,
                      )
                    : null,
                  rotationResult !== null && rotationResult.provider === entry.provider
                    ? h(
                        'p',
                        { style: rotationResult.ok === true ? styles.hint : styles.error, role: 'status' },
                        `${locale('accountRotationResult')} (${rotationResult.runs}×) · ${rotationResult.accounts
                          .map(
                            (account) =>
                              `${account.kind === 'default' ? locale('accountDefault') : account.label ?? account.id} ${locale('accountRequests')} ${account.requests} · ${locale('accountSuccesses')} ${account.successes}`,
                          )
                          .join(' · ')}${
                          rotationResult.ok === true
                            ? ''
                            : ` · ${locale('accountRotationFailed')}: ${rotationResult.results
                                .filter((result) => result.ok !== true)
                                .map((result) => result.failure?.code ?? 'ERROR')
                                .join(', ')}`
                        }`,
                      )
                    : null,
                  entry.registered && payload.accounts.credentialsAvailable !== false
                    ? h(
                        'div',
                        { style: { ...styles.row, marginTop: 2 } },
                        h('input', {
                          type: 'text',
                          style: styles.textInput,
                          placeholder: locale('accountAddLabelPlaceholder'),
                          value: accountForm.label,
                          onChange: (event) => setAccountForm((current) => ({ ...current, label: event.target.value })),
                        }),
                        h('input', {
                          type: 'password',
                          style: styles.textInput,
                          placeholder: locale('accountAddKeyPlaceholder'),
                          value: accountForm.key,
                          onChange: (event) => setAccountForm((current) => ({ ...current, key: event.target.value })),
                          autoComplete: 'off',
                          spellCheck: false,
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: styles.primaryButton,
                            disabled: accountBusy !== null,
                            onClick: () => createAccount(entry.provider),
                          },
                          accountBusy === 'create' ? locale('accountAdding') : locale('accountAdd'),
                        ),
                      )
                    : null,
                  h('p', { style: styles.muted }, locale('accountSupportsHint')),
                )
              }),
            ),

        draft === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h(
                'div',
                { style: styles.spread },
                h('h2', { style: styles.cardTitle }, locale('chainTitle')),
                dirty ? h('span', { style: styles.badBadge }, locale('dirty')) : null,
              ),
              h('p', { style: styles.hint }, locale('chainHint')),
              draft.chain.length === 0
                ? h('p', { style: styles.hint }, locale('chainEmpty'))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    draft.chain.map((entry, index) => {
                      const catalog = models[entry.provider] || []
                      const selectValue = entry.model === '' ? '__inherit__' : entry.model
                      const known = catalog.some((model) => model.id === entry.model)
                      return h(
                        'div',
                        { key: `${entry.provider}:${index}`, style: styles.chainRow },
                        h(
                          'div',
                          { style: styles.chainHead },
                          h('span', { style: styles.index }, String(index + 1)),
                          h(
                            'div',
                            { style: styles.chainMeta },
                            h('span', { style: styles.providerName }, entry.provider),
                            h(
                              'span',
                              { style: styles.providerId },
                              catalog.length === 0 ? locale('noModels') : `${catalog.length} models`,
                            ),
                          ),
                          h('button', { type: 'button', style: styles.smallButton, onClick: () => removeAt(index) }, '×'),
                        ),
                        h(
                          'div',
                          { style: styles.chainControls },
                          h(
                            'select',
                            {
                              style: styles.select,
                              value: selectValue,
                              onChange: (event) =>
                                setEntryModel(index, event.target.value === '__inherit__' ? '' : event.target.value),
                            },
                            h('option', { value: '__inherit__' }, locale('inheritModel')),
                            catalog.map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id)),
                            known || entry.model === '' || catalog.length > 0
                              ? null
                              : h('option', { value: entry.model }, entry.model),
                          ),
                          h(
                            'button',
                            { type: 'button', style: styles.smallButton, onClick: () => move(index, -1), disabled: index === 0 },
                            '↑',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              style: styles.smallButton,
                              onClick: () => move(index, 1),
                              disabled: index === draft.chain.length - 1,
                            },
                            '↓',
                          ),
                        ),
                      )
                    }),
                  ),
              h('p', { style: styles.hint }, locale('addTitle') + ' — ' + locale('addHint')),
              candidates.length === 0
                ? null
                : h(
                    'div',
                    { style: styles.row },
                    candidates.map((provider) =>
                      h(
                        'button',
                        {
                          key: provider.id,
                          type: 'button',
                          style: { ...styles.smallButton, borderColor: 'var(--dsw-alias-brand-primary)' },
                          onClick: () => addProvider(provider),
                        },
                        `${locale('add')} ${provider.name}`,
                      ),
                    ),
                  ),
              payload !== null && payload.configurable.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('span', { style: styles.muted }, locale('configurableTitle')),
                    h(
                      'p',
                      { style: styles.hint },
                      `${payload.configurable
                        .slice(0, 8)
                        .map((entry) => entry.displayName || entry.provider)
                        .join(', ')}${
                        payload.configurable.length > 8 ? ` +${payload.configurable.length - 8}` : ''
                      } — ${locale('configurableHint')}`,
                    ),
                  )
                : null,
            ),

        draft === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h('h2', { style: styles.cardTitle }, locale('codesTitle')),
              h('p', { style: styles.hint }, locale('codesHint')),
              h(
                'div',
                { style: styles.codeGrid },
                TRIGGER_CODES.map((code) =>
                  h(
                    'label',
                    { key: code, style: styles.check },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.fallbackCodes.includes(code),
                      onChange: () => toggleCode(code),
                    }),
                    h('span', { style: styles.mono }, code),
                    h('span', { style: styles.muted }, CODE_LABELS[code] || ''),
                  ),
                ),
              ),
              h(
                'div',
                { style: styles.row },
                h('span', { style: { fontSize: 12 } }, locale('maxAttempts')),
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 8,
                  style: styles.input,
                  value: draft.maxAttempts,
                  onChange: (event) => {
                    const value = Math.max(1, Math.min(8, Number(event.target.value) || 1))
                    updateDraft((next) => {
                      next.maxAttempts = value
                    })
                  },
                }),
              ),
              h('h2', { style: styles.cardTitle }, locale('cooldownTitle')),
              h(
                'div',
                { style: styles.row },
                h('span', { style: { fontSize: 12 } }, locale('cooldownQuota')),
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 1440,
                  style: styles.input,
                  value: draft.cooldownQuotaMin,
                  onChange: (event) => {
                    const value = Math.max(0, Math.min(1440, Number(event.target.value) || 0))
                    updateDraft((next) => {
                      next.cooldownQuotaMin = value
                    })
                  },
                }),
                h('span', { style: { fontSize: 12 } }, locale('cooldownRate')),
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 3600,
                  style: styles.input,
                  value: draft.cooldownRateSec,
                  onChange: (event) => {
                    const value = Math.max(0, Math.min(3600, Number(event.target.value) || 0))
                    updateDraft((next) => {
                      next.cooldownRateSec = value
                    })
                  },
                }),
              ),
              h(Toggle, {
                checked: draft.enabled,
                onChange: (checked) => {
                  updateDraft((next) => {
                    next.enabled = checked
                  })
                },
                label: locale('enabled'),
                hint: locale('enabledHint'),
              }),
            ),

        error === null ? null : h('p', { style: styles.error, role: 'alert' }, `${locale('errorPrefix')} ${error}`),
        notice === null ? null : h('p', { style: styles.hint }, notice),

        draft === null
          ? null
          : h(
              'div',
              { style: styles.row },
              h('button', { type: 'button', style: styles.primaryButton, onClick: save, disabled: busy || !dirty }, locale('save')),
              h('button', { type: 'button', style: styles.button, onClick: resetOverrides, disabled: busy }, locale('reset')),
              h('button', { type: 'button', style: styles.button, onClick: runTest, disabled: busy }, locale('test')),
              busy ? h('span', { style: styles.muted }, `${busyLabel === 'test' ? locale('testing') : locale('saving')}`) : null,
              h('span', { style: styles.muted }, locale('testHint')),
            ),

        testResult === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h(
                'div',
                { style: styles.spread },
                h('h2', { style: styles.cardTitle }, locale('testTitle')),
                testResult.ok === true
                  ? h(
                      'span',
                      { style: styles.okBadge },
                      `${locale('testAnswered')} ${testResult.answered ? testResult.answered.provider : '?'}`,
                    )
                  : h('span', { style: styles.errorBadge }, locale('testFailed')),
              ),
              testResult.failure !== undefined && testResult.failure !== null
                ? h('p', { style: styles.error }, `${testResult.failure.code}: ${testResult.failure.message || ''}`)
                : null,
              testResult.attempts === undefined
                ? null
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('span', { style: styles.muted }, locale('testAttempts')),
                    testResult.attempts.map((attempt, index) =>
                      h(
                        'div',
                        { key: `${attempt.provider}:${index}`, style: styles.eventRow },
                        h('span', { style: styles.mono }, String(index + 1)),
                        h('span', { style: attempt.ok === true ? styles.okBadge : attempt.ok === false ? styles.errorBadge : styles.badge },
                          attempt.ok === true ? 'ok' : attempt.ok === false ? 'failed' : '…'),
                        h('span', { style: styles.mono }, `${attempt.provider}/${attempt.model || '—'}`),
                        attempt.code ? h('span', { style: styles.muted }, attempt.code) : null,
                        attempt.latencyMs !== undefined ? h('span', { style: styles.muted }, `${attempt.latencyMs} ms`) : null,
                      ),
                    ),
                  ),
              typeof testResult.text === 'string' && testResult.text.length > 0
                ? h('pre', { style: styles.pre }, testResult.text)
                : null,
            ),

        payload === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h(
                'div',
                { style: styles.spread },
                h('h2', { style: styles.cardTitle }, locale('eventsTitle')),
                h('button', { type: 'button', style: styles.smallButton, onClick: clearEvents }, locale('clear')),
              ),
              payload.events.length === 0
                ? h('p', { style: styles.hint }, locale('eventsEmpty'))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    payload.events
                      .slice()
                      .reverse()
                      .slice(0, 12)
                      .map((event, index) =>
                        h(
                          'div',
                          { key: `${event.at}:${index}`, style: styles.eventRow },
                          h('span', { style: styles.muted }, formatClock(event.at)),
                          h(
                            'span',
                            { style: event.kind === 'answered' ? styles.okBadge : styles.badBadge },
                            event.kind,
                          ),
                          event.from !== null && event.from !== undefined
                            ? h(
                                'span',
                                { style: styles.mono },
                                `${event.from.provider}/${event.from.model}${
                                  event.from.account === undefined ? '' : ` [${event.from.account.label ?? event.from.account.id}]`
                                }`,
                              )
                            : null,
                          h('span', { style: styles.muted }, '→'),
                          event.to !== null && event.to !== undefined
                            ? h(
                                'span',
                                { style: styles.mono },
                                `${event.to.provider}/${event.to.model}${
                                  event.to.account === undefined ? '' : ` [${event.to.account.label ?? event.to.account.id}]`
                                }`,
                              )
                            : h('span', { style: styles.muted }, '—'),
                          event.code ? h('span', { style: styles.mono }, event.code) : null,
                          event.latencyMs !== undefined ? h('span', { style: styles.muted }, `${event.latencyMs} ms`) : null,
                        ),
                      ),
                  ),
            ),
      )
    }

    // -------------------------------------------------------------------
    // Navigation: left-sidebar panel entry + the root `main` page it selects.
    // The panel ids must match byte for byte: the sidebar resolves a
    // `sidebar.panellist` entry to the root `main` keyed panel with the same
    // id.
    // -------------------------------------------------------------------

    const PANEL_ID = '@dsh-fallback/router-fallback'

    function RouterFallbackIcon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M5 7.5h8.5A3.5 3.5 0 0 1 17 11v6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M14 16.5l3 3 3-3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M19 16.5h-8.5A3.5 3.5 0 0 1 7 13V6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.55,
        }),
        h('circle', { cx: 5, cy: 7.5, r: 2.1, fill: 'currentColor' }),
        h('circle', { cx: 19, cy: 16.5, r: 1.7, fill: 'currentColor', opacity: 0.8 }),
      )
    }

    /** Resolve one navigation label through the optional locale service. */
    function navText(ctx) {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (service !== undefined && typeof service.bind === 'function') {
          const translated = service.bind(NS)('nav')
          if (typeof translated === 'string' && translated.length > 0 && translated !== 'nav') return translated
        }
      } catch (error) {
        // fall through to English
      }
      return COPY.en.nav
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const service = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (service !== undefined && typeof service.register === 'function') {
            ctx.effect(() => service.register(NS, { en: COPY.en, ko: COPY.ko }), 'dsh-fallback: locale dictionaries')
          }
        } catch (error) {
          // A shell without the optional locale service falls back to English.
        }

        // Root keyed `main` page. Registered without a Session so router
        // configuration is reachable even in the blank new-session state.
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  order: 45,
                },
                (props) => h(RouterFallbackSection, { ...props, ctx }),
              ),
            ),
          'dsh-fallback: router fallback page',
        )

        // Left-sidebar entry that selects the page above (same id).
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 45,
                  locale: NS,
                  label: () => navText(ctx),
                },
                () => h(RouterFallbackIcon, { size: 16 }),
              ),
            ),
          'dsh-fallback: sidebar entry',
        )
      },
    }
  },
})
