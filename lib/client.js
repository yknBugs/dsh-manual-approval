/**
 * Manual approval permission mode — browser half.
 *
 * Two surfaces, both additive:
 *
 * 1. `conversation.approval.detail` — the panel the shipped approval card
 *    declares for "the tool call correlated with this approval". It shows the
 *    tool name, one line per argument, any rule warning in red, and the optional
 *    feedback box. The shipped card keeps its own headline and its decision
 *    buttons; feedback is committed in the same click, from a capture-phase
 *    listener that never calls `stopPropagation`.
 *
 * 2. `settings.section` — a "Manual mode rules" page holding the master switch
 *    and the ordered rule list (conditions -> action).
 *
 * Plain JavaScript, no imports: `__ModuleLoader__` wraps this file and supplies
 * `require` from the host boot.
 */

window.__ModuleLoader__.load({
  id: 'dsh-manual-approval',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    var SLOT_DETAIL = 'conversation.approval.detail'
    var SLOT_SETTINGS = 'settings.section'
    var SETTINGS_SECTION_ID = 'manual-approval'
    var REASON_PREFIX = '[manual approval]'
    var PAGE_GLOBAL = '__DSH_MANUAL_APPROVAL__'
    var STYLE_ID = 'dsh-manual-approval/client.css'
    var PANEL_ATTR = 'data-dsh-manual-approval-panel'
    var RULES_QUERY = '?rules=1'
    /**
     * The shipped chat UI registers its command preview into the SINGLE
     * `conversation.approval.detail` slot at the default priority 0, so this
     * panel must register LOWER to take the seam (the slot's own error text: "the
     * lowest renders"). -1 shadows it deterministically regardless of load order.
     */
    var DETAIL_PRIORITY = -1

    var TARGETS = [
      { value: 'toolName', label: 'target.toolName' },
      { value: 'argName', label: 'target.argName' },
      { value: 'argValue', label: 'target.argValue' },
    ]
    var ACTIONS = [
      { value: 'approve', label: 'action.approve' },
      { value: 'deny', label: 'action.deny' },
      { value: 'warn', label: 'action.warn' },
      { value: 'judge', label: 'action.judge' },
    ]
    /** Action kind → locale key, for the collapsed card's action badge. */
    var ACTION_LABEL = { approve: 'action.approve', deny: 'action.deny', warn: 'action.warn', judge: 'action.judge' }

    /**
     * This plugin's own copy, in both shipped languages.
     *
     * Registered through `ctx.locale.register(NS, 'zh'|'en', dict)`. English is
     * the fallback the locale service consults for any key the active language
     * misses, and the same dictionary answers when no locale service is composed
     * at all, so the UI is never keyless.
     */
    var NS = 'manual-approval'
    var DICT = {
      en: {
        'panel.tool': 'Tool: ',
        'panel.parameters': 'Parameters',
        'panel.parametersUnavailable': 'Parameters (unavailable)',
        'panel.parametersLoading': 'Parameters (loading…)',
        'panel.feedbackLabel': 'Feedback (optional) — attached to this call\'s result',
        'panel.feedbackPlaceholder': 'Add a note or a reason for your decision…',
        'panel.feedbackAria': 'Manual approval feedback',
        'panel.warningFromRule': 'Warning from rule: {name}',
        'page.title': 'Manual mode rules',
        'page.intro': 'Rules are evaluated in order while the permission mode is Manual; the first match decides. A rule that allows skips the prompt, a rule that denies returns its reason instead, a rule that warns still asks you but shows the warning in red, and a network judge asks your endpoint. With no match, the call opens the normal approval prompt.',
        'page.storedAt': 'Stored at {path}',
        'page.loading': 'Loading rules…',
        'page.masterOn': 'Rules active',
        'page.masterHint': 'When off, every rule is inert and every call asks.',
        'page.reload': 'Reload',
        'page.save': 'Save',
        'page.saved': 'Saved',
        'page.saving': 'saving…',
        'page.addRule': 'Add rule',
        'page.ruleCount': '{count} rule(s)',
        'page.empty': 'No rules yet. With none, Manual behaves as plain manual approval: every call asks you.',
        'page.endpointUnavailable': 'the plugin endpoint is unavailable in this composition',
        'page.loadFailed': 'could not load rules',
        'page.saveFailed': 'save failed: {error}',
        'page.unknownError': 'unknown error',
        'page.savedWithInvalid': 'saved — {count} rule(s) cannot be enabled',
        'page.newRule': 'New rule',
        'page.copySuffix': ' (copy)',
        'rule.enabled': 'Enabled',
        'rule.name': 'Rule name',
        'rule.conditionsHint': 'Conditions (all must match; first matching rule wins)',
        'rule.target': 'Match target',
        'rule.pattern': 'Regular expression',
        'rule.patternPlaceholder': 'e.g. ^pwsh$ or rm\\s+-rf',
        'rule.noGroups': 'no capture groups',
        'rule.addCondition': 'Add condition',
        'rule.remove': 'Remove',
        'rule.duplicate': 'Duplicate',
        'rule.delete': 'Delete',
        'rule.action': 'Action',
        'rule.reasonOptional': 'Reason (optional)',
        'rule.contentOptional': 'Content (optional)',
        'rule.denyHint': 'A rule denial reads exactly like a denial the user typed, so the model cannot tell them apart. Uses $1, $2 … for capture groups.',
        'rule.messageHint': 'Uses $1, $2 … for capture groups.',
        'rule.warnContent': 'Warning text (optional)',
        'rule.warnHint': 'Shown in red in the approval card. Empty shows: The parameters matched rule \"<name>\". Uses $1, $2 …',
        'rule.url': 'URL (required)',
        'rule.urlPlaceholder': 'http://127.0.0.1:8080/judge',
        'rule.method': 'Method',
        'rule.timeout': 'Timeout (ms)',
        'rule.decisionPath': 'Decision path (required)',
        'rule.decisionPathPlaceholder': 'result.decision',
        'rule.reasonPath': 'Reason path (optional)',
        'rule.reasonPathPlaceholder': 'result.why',
        'rule.headers': 'Request headers (optional, one per line)',
        'rule.body': 'Request body (optional)',
        'rule.bodyPlaceholder': 'Defaults to {\"<tool>\":{\"<arg>\":\"<value>\"}}. Uses $1, $2 …',
        'rule.judgeHint': 'The decision path must resolve to \"approve\", \"deny\" or \"ask\". Any failure — unreachable host, bad status, invalid JSON, missing or unexpected value — falls back to a red warning, and the call still goes to you.',
        'rule.capturesNone': 'This rule captures no groups.',
        'rule.capturesRange': 'This rule exposes $1 … ${last} to its message.',
        'rule.expand': 'Edit',
        'rule.collapse': 'Collapse',
        'rule.collapseHint': 'Collapse it to keep the list short.',
        'rule.summaryJoin': '  ·  ',
        'rule.noConditions': 'No conditions yet — this rule matches everything.',
        'rule.moveUp': 'Move up (earlier = higher priority)',
        'rule.moveDown': 'Move down',
        'rule.invalidBadge': 'invalid',
        'target.toolName': 'Tool name',
        'target.argName': 'Parameter name',
        'target.argValue': 'Parameter value',
        'action.approve': 'Allow',
        'action.deny': 'Deny',
        'action.warn': 'Warn at approval',
        'action.judge': 'Network judge',
      },
      zh: {
        'panel.tool': '工具：',
        'panel.parameters': '参数',
        'panel.parametersUnavailable': '参数（不可用）',
        'panel.parametersLoading': '参数（加载中…）',
        'panel.feedbackLabel': '反馈（可选）—— 会附加到本次调用的结果里',
        'panel.feedbackPlaceholder': '填写你的备注或作出该决定的理由…',
        'panel.feedbackAria': '手动批准反馈',
        'panel.warningFromRule': '来自规则 {name} 的警告',
        'page.title': '手动批准规则',
        'page.intro': '权限模式为「手动批准」时，规则按顺序依次判断，第一条匹配的规则决定结果：放行则跳过弹窗；拒绝则直接返回理由；附加警告则仍然询问你，但在卡片里用红色显示警告；联网判断则去问你配置的服务器。没有任何规则匹配时，才会弹出常规审批。',
        'page.storedAt': '存储位置：{path}',
        'page.loading': '正在加载规则…',
        'page.masterOn': '规则已启用',
        'page.masterHint': '关闭后所有规则失效，每次调用都会询问你。',
        'page.reload': '重新加载',
        'page.save': '保存',
        'page.saved': '已保存',
        'page.saving': '正在保存…',
        'page.addRule': '添加规则',
        'page.ruleCount': '共 {count} 条规则',
        'page.empty': '还没有规则。没有规则时，「手动批准」就是纯粹的逐次审批：每次调用都会问你。',
        'page.endpointUnavailable': '当前组合中没有可用的插件接口',
        'page.loadFailed': '无法加载规则',
        'page.saveFailed': '保存失败：{error}',
        'page.unknownError': '未知错误',
        'page.savedWithInvalid': '已保存 —— 有 {count} 条规则无法启用',
        'page.newRule': '新规则',
        'page.copySuffix': '（副本）',
        'rule.enabled': '启用',
        'rule.name': '规则名称',
        'rule.conditionsHint': '条件（需全部满足；第一条匹配的规则生效）',
        'rule.target': '匹配对象',
        'rule.pattern': '正则表达式',
        'rule.patternPlaceholder': '例如 ^pwsh$ 或 rm\\s+-rf',
        'rule.noGroups': '无捕获组',
        'rule.addCondition': '添加条件',
        'rule.remove': '删除条件',
        'rule.duplicate': '复制',
        'rule.delete': '删除',
        'rule.action': '执行操作',
        'rule.reasonOptional': '理由（选填）',
        'rule.contentOptional': '内容（选填）',
        'rule.denyHint': '规则的拒绝与用户手写的拒绝完全同形，模型无法分辨两者。可用 $1、$2 … 引用捕获组。',
        'rule.messageHint': '可用 $1、$2 … 引用捕获组。',
        'rule.warnContent': '警告内容（选填）',
        'rule.warnHint': '会在审批卡片里用红色显示。留空时显示：参数触发了规则「<name>」。可用 $1、$2 …',
        'rule.url': '网址（必填）',
        'rule.urlPlaceholder': 'http://127.0.0.1:8080/judge',
        'rule.method': '请求方法',
        'rule.timeout': '超时（毫秒）',
        'rule.decisionPath': '决定字段路径（必填）',
        'rule.decisionPathPlaceholder': 'result.decision',
        'rule.reasonPath': '理由字段路径（选填）',
        'rule.reasonPathPlaceholder': 'result.why',
        'rule.headers': '请求头（选填，每行一条）',
        'rule.body': '请求体（选填）',
        'rule.bodyPlaceholder': '默认为 {\"<工具名>\":{\"<参数名>\":\"<参数值>\"}}。可用 $1、$2 …',
        'rule.judgeHint': '决定字段路径的取值必须是 \"approve\"、\"deny\" 或 \"ask\"。任何一步异常——主机不可达、状态码异常、返回体不是 JSON、路径不存在或取值非预期——都会回退为红色警告，这次调用仍然交给你判断。',
        'rule.capturesNone': '这条规则没有捕获组。',
        'rule.capturesRange': '这条规则可在消息中引用 $1 … ${last}。',
        'rule.expand': '编辑',
        'rule.collapse': '收起',
        'rule.collapseHint': '收起后这一条只占一行，列表更紧凑。',
        'rule.summaryJoin': '　·　',
        'rule.noConditions': '还没有条件 —— 这条规则会匹配所有调用。',
        'rule.moveUp': '上移（越靠前优先级越高）',
        'rule.moveDown': '下移',
        'rule.invalidBadge': '无效',
        'target.toolName': '工具名称',
        'target.argName': '参数名称',
        'target.argValue': '参数值',
        'action.approve': '放行',
        'action.deny': '拒绝',
        'action.warn': '审批时附加警告',
        'action.judge': '联网判断',
      },
    }

    /**
     * The active translator, bound in `apply`.
     *
     * Held in module scope because the slot system renders the components with
     * only its own props, so there is no prop channel to pass a function through.
     */
    var translate = function (key, params) {
      return interpolate(DICT.en[key] === undefined ? key : DICT.en[key], params)
    }

    function setTranslator(next) {
      if (typeof next === 'function') translate = next
    }

    /** Replace `{name}` placeholders. */
    function interpolate(template, params) {
      if (typeof template !== 'string') return ''
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        var value = params[name]
        return value === undefined || value === null ? match : String(value)
      })
    }

    /**
     * `locale` is a declared dependency, not an optional lookup.
     *
     * Without it the plugin applied BEFORE the locale service existed,
     * `ctx.get('locale')` returned undefined, and every label silently fell back
     * to English — so the settings page stayed English while the rest of DSH was
     * Chinese. `package.json` also lists `@deepseek-ai/dsh-client-locale` under
     * `dsh.client.inject`, which is what orders the boot graph.
     */
    var inject = ['slots', 'locale']

    /** Console diagnostics, never fatal: the tree loads as a unit. */
    function describeError(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function warn(message) {
      try {
        console.warn('[manual-approval] ' + message)
      } catch {
        // A missing console must not break activation.
      }
    }

    // ---------------------------------------------------------------------
    // Styles: official design tokens, so the panels match the shipped UI.
    // ---------------------------------------------------------------------
    var CSS = [
      '.dshm_body{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dshm_head{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.dshm_head code{font-family:var(--ds-font-family-code)}',
      '.dshm_label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshm_rows{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto}',
      '.dshm_row{display:flex;gap:8px;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;word-break:break-all}',
      '.dshm_key{flex:0 0 auto;min-width:88px;color:var(--dsw-alias-label-tertiary)}',
      '.dshm_val{flex:1 1 auto;color:var(--dsw-alias-label-primary);white-space:pre-wrap}',
      '.dshm_warn{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-state-error-tertiary,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d);font-size:13px;line-height:20px;white-space:pre-wrap}',
      '.dshm_warnMark{flex:0 0 auto;font-weight:700}',
      '.dshm_input{box-sizing:border-box;width:100%;min-height:56px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:var(--dsw-specific-input-major,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;resize:vertical;outline:none}',
      '.dshm_input:focus{border-color:var(--dsw-alias-border-inverted,rgba(0,0,0,.3))}',
      // settings page
      '.dshm_page{display:flex;flex-direction:column;gap:14px;padding:4px 2px 32px}',
      '.dshm_pageHead{display:flex;flex-direction:column;gap:4px}',
      '.dshm_title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}',
      '.dshm_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshm_bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dshm_card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2,transparent)}',
      '.dshm_cardBad{border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dshm_cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshm_field{display:flex;flex-direction:column;gap:3px}',
      '.dshm_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshm_text,.dshm_select,.dshm_area{box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:9px;background:var(--dsw-specific-input-major,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;outline:none}',
      '.dshm_text{min-width:120px;flex:1 1 auto}',
      '.dshm_area{width:100%;min-height:52px;resize:vertical;font-family:var(--ds-font-family-code);font-size:12px}',
      '.dshm_grow{flex:1 1 auto}',
      '.dshm_cond{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}',
      '.dshm_badge{flex:0 0 auto;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px}',
      '.dshm_btn{padding:5px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.dshm_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshm_btn:disabled{opacity:.55;cursor:not-allowed}',
      // `--dsw-alias-label-on-fill` does NOT exist in the shipped theme, so the
      // primary label fell back to white and vanished under the disabled
      // treatment (the invisible Save button). `--dsw-alias-label-primary-foreground`
      // is the theme's real foreground-on-fill token.
      '.dshm_btnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#171717);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dshm_btnDanger{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dshm_errors{margin:0;padding-left:18px;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px}',
      '.dshm_switch{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.dshm_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.dshm_ok{color:var(--dsw-alias-state-success-primary,#2f9e44);font-size:12px}',
      '.dshm_groupHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dshm_summary{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;word-break:break-all}',
      '.dshm_bad{flex:0 0 auto;padding:2px 7px;border-radius:999px;background:transparent;border:1px solid var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px;line-height:16px}',
      '.dshm_toggle{flex:0 0 auto}',
      '.dshm_editor{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-top:10px}',
    ].join('')

    /**
     * Install the style tag once.
     *
     * Deliberately avoids an attribute selector: `STYLE_ID` contains a slash, so
     * building `style[data-plugin-css="…"]` by hand is easy to get wrong, and a
     * malformed selector throws at activation — which the harness reports as
     * "failed to apply loader entry". Comparing the property directly cannot
     * produce an invalid selector at all.
     */
    function findStyle(document) {
      var tags = document.querySelectorAll('style[data-plugin-css]')
      for (var index = 0; index < tags.length; index += 1) {
        if (tags[index].dataset && tags[index].dataset.pluginCss === STYLE_ID) return tags[index]
      }
      return null
    }

    function upsertStyle(document) {
      if (findStyle(document) !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-manual-approval'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function pageGlobals() {
      var holder = window[PAGE_GLOBAL]
      if (holder === null || typeof holder !== 'object') return { token: '', endpoint: '', rulesEndpoint: '' }
      return {
        token: typeof holder.token === 'string' ? holder.token : '',
        endpoint: typeof holder.endpoint === 'string' ? holder.endpoint : '',
        rulesEndpoint: typeof holder.rulesEndpoint === 'string' ? holder.rulesEndpoint : '',
      }
    }

    function request(path, options) {
      var globals = pageGlobals()
      if (globals.token === '' || path === '') return Promise.reject(new Error(translate('page.endpointUnavailable')))
      var headers = { 'x-manual-approval-token': globals.token }
      if (options !== undefined && options.body !== undefined) headers['content-type'] = 'application/json'
      return fetch(path, {
        method: options === undefined ? 'GET' : (options.method || 'GET'),
        headers: headers,
        cache: 'no-store',
        ...(options !== undefined && options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }).then(function (response) {
        return response.json().catch(function () { return { ok: false, error: 'HTTP ' + response.status } })
      })
    }

    // ---------------------------------------------------------------------
    // Approval detail panel
    // ---------------------------------------------------------------------

    function resolveCallId(props) {
      if (typeof props.callId === 'string' && props.callId !== '') return props.callId
      try {
        var card = document.querySelector('[data-approval-key]')
        return card === null ? '' : (card.getAttribute('data-approval-key') || '')
      } catch (error) {
        return ''
      }
    }

    /**
     * The INNERMOST div under `root` whose text starts with `prefix`, or null.
     *
     * An ancestor can carry the same leading text while also owning the panel's
     * own children, and its `textContent` is every child's text concatenated.
     * Reading an ancestor is what rendered the whole argument list into the
     * headline. The element that actually holds the sentence is the matching one
     * with no nested div; if there is no such element, fall back to the first
     * match so a differently-shaped card still yields something.
     */
    function innermostDivStartingWith(root, prefix) {
      var nodes = root.querySelectorAll('div')
      var firstMatch = null
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index]
        var text = node.textContent
        if (typeof text !== 'string' || text.indexOf(prefix) !== 0) continue
        if (firstMatch === null) firstMatch = text
        if (node.querySelector('div') === null) return text
      }
      return firstMatch
    }

    /** Our approval headline's text, or null. */
    function headlineText() {
      try {
        var card = document.querySelector('[data-approval-key]')
        if (card === null) return null
        return innermostDivStartingWith(card, REASON_PREFIX)
      } catch (error) {
        return null
      }
    }

    /** The call's key, read from the tail of our approval headline. */
    function resolveRefKey() {
      var text = headlineText()
      if (text === null) return ''
      var match = /\(ref\s+([^)]+)\)\s*$/.exec(text)
      return match === null ? '' : match[1].trim()
    }

    /**
     * The tool name, read from the same headline.
     *
     * Deliberately built on `resolveRefKey` instead of a second greedy regex: the
     * headline is `Confirm tool call: <name> — <model's description> (ref <key>)`,
     * so `(.+?)(\(ref…\))?$` happily swallows the description into the name. The
     * ref is the only reliable right-hand boundary, and it already parses.
     */
    function resolveToolName(props) {
      if (props !== undefined && typeof props.toolName === 'string' && props.toolName !== '') return props.toolName
      var text = headlineText()
      if (text === null) return ''
      var key = resolveRefKey()
      var body = key === '' ? text : text.slice(0, text.lastIndexOf('(ref'))
      var name = body.replace(/^\s*\[manual approval\]\s*/, '').replace(/^\s*Confirm tool call:\s*/, '')
      // Everything after the first em dash is the model's own description, not
      // part of the tool name.
      var dash = name.indexOf(' — ')
      if (dash >= 0) name = name.slice(0, dash)
      return name.trim()
    }

    /**
     * Our panel for the control that was clicked, or null.
     *
     * The shipped approval card does NOT nest the decision buttons inside the
     * detail panel. Its shape is:
     *
     *   [data-approval-key]
     *     └ card
     *        ├ body      → headline, command (← THIS plugin's panel)
     *        └ actionRow → Reject, Allow once
     *
     * so the panel is a **sibling of the button row**, and walking up from the
     * clicked button can never reach it. That walk is exactly why a note typed
     * and then answered by clicking allow was silently dropped while
     * focus/blur-triggered paths appeared to work.
     *
     * Resolve structurally instead: take the card the control belongs to, then
     * look for the panel inside it. Both the up-walk (for a future card that
     * does nest it) and a document-wide fallback are kept, so a differently
     * shaped card still yields the panel.
     */
    function findPanel(node) {
      var card = null
      var element = node
      while (element !== null && element !== undefined) {
        if (element.nodeType === 1 && typeof element.hasAttribute === 'function') {
          if (element.hasAttribute(PANEL_ATTR)) return element
          if (card === null && element.hasAttribute('data-approval-key')) card = element
        }
        element = element.parentNode
      }
      if (card !== null && typeof card.querySelector === 'function') {
        var nested = card.querySelector('[' + PANEL_ATTR + ']')
        if (nested !== null) return nested
      }
      var anywhere = document.querySelectorAll('[' + PANEL_ATTR + ']')
      return anywhere.length === 1 ? anywhere[0] : null
    }

    function submitFeedback(text) {
      if (typeof text !== 'string' || text.trim() === '') return
      var globals = pageGlobals()
      if (globals.token === '' || globals.endpoint === '') return
      var key = resolveRefKey()
      if (key === '') return
      // A plain fetch, deliberately. `navigator.sendBeacon` is the obvious
      // "survives unmount" tool, but it cannot set the `x-manual-approval-token`
      // header the route requires, so the request would be refused. `keepalive`
      // is also avoided: a typed note must be *in* the host before the approval
      // it belongs to settles, and a fire-and-forget request raced that.
      try {
        void fetch(globals.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manual-approval-token': globals.token },
          body: JSON.stringify({ key: key, text: text }),
        }).catch(function () { /* the decision must never be blocked by delivery */ })
      } catch (error) {
        // A failed delivery only loses the note.
      }
    }

    /**
     * The latest text seen in one panel's box.
     *
     * Cached on every keystroke, so a decision reads what the user actually typed
     * even if the textarea is gone, re-created, or has lost focus by the time the
     * click arrives.
     */
    var draftByPanel = new WeakMap()

    function draftOf(panel) {
      var textarea = panel.querySelector('textarea')
      var live = textarea === null ? undefined : textarea.value
      if (typeof live === 'string' && live !== '') {
        draftByPanel.set(panel, live)
        return live
      }
      return draftByPanel.get(panel) || ''
    }

    /**
     * Commit the feedback box in the same user action that answers the approval.
     *
     * Capture phase, and deliberately no `stopPropagation`: the official button
     * still receives the click and still performs the decision. `pointerdown` is
     * handled as well as `click`, because a pointerdown that starts on the button
     * may not produce a click if the card re-renders underneath it.
     */
    function installCommitOnDecision(document) {
      // A real pointer press fires BOTH `pointerdown` and `click`, and both are
      // registered (a press that starts on the button can lose its click if the
      // card re-renders underneath it). Without this, one answer would deliver
      // the same note twice. Keyed by panel so a fresh card is never suppressed,
      // and reset whenever the box's text changes, so a genuinely new note is
      // never swallowed.
      var lastCommitted = new WeakMap()
      var commit = function (event) {
        var target = event.target
        if (target === null || target === undefined || target.nodeType !== 1) return
        if (typeof target.closest !== 'function') return
        var panel = findPanel(target)
        if (panel === null) return
        var note = draftOf(panel)
        if (note === '') return
        if (lastCommitted.get(panel) === note) return
        lastCommitted.set(panel, note)
        submitFeedback(note)
      }
      // Remember every keystroke so the value survives a re-render.
      var remember = function (event) {
        var target = event.target
        if (target === null || target === undefined || target.nodeType !== 1) return
        if (target.tagName !== 'TEXTAREA') return
        var panel = findPanel(target)
        if (panel === null) return
        draftByPanel.set(panel, String(target.value))
        lastCommitted.delete(panel)
      }
      document.addEventListener('input', remember, true)
      document.addEventListener('pointerdown', commit, true)
      document.addEventListener('click', commit, true)
      return function () {
        document.removeEventListener('input', remember, true)
        document.removeEventListener('pointerdown', commit, true)
        document.removeEventListener('click', commit, true)
      }
    }

    function renderRows(rows) {
      return React.createElement(
        'div',
        { className: 'dshm_rows' },
        rows.map(function (row, index) {
          var at = row.indexOf(': ')
          var key = at > 0 ? row.slice(0, at) : ''
          var value = at > 0 ? row.slice(at + 2) : row
          return React.createElement(
            'div',
            { className: 'dshm_row', key: String(index) + ':' + key },
            key === '' ? null : React.createElement('span', { className: 'dshm_key' }, key),
            React.createElement('span', { className: 'dshm_val' }, value),
          )
        }),
      )
    }

    function ManualApprovalDetail(props) {
      var state = React.useState(null)
      var view = state[0]
      var setView = state[1]
      var toolName = resolveToolName(props)
      var callId = resolveCallId(props)

      React.useEffect(function () {
        var globals = pageGlobals()
        var key = resolveRefKey()
        if (globals.token === '' || globals.endpoint === '' || key === '') return function () {}
        var cancelled = false
        fetch(globals.endpoint + '?key=' + encodeURIComponent(key), {
          headers: { 'x-manual-approval-token': globals.token },
          cache: 'no-store',
        })
          .then(function (response) { return response.json() })
          .then(function (payload) {
            if (cancelled) return
            if (payload !== null && typeof payload === 'object') setView(payload)
          })
          .catch(function () { /* the panel still works without detail */ })
        return function () { cancelled = true }
      }, [])

      var rows = view !== null && Array.isArray(view.rows) ? view.rows : null
      var warning = view !== null && typeof view.warning === 'string' && view.warning !== '' ? view.warning : null
      var ruleName = view !== null && typeof view.ruleName === 'string' ? view.ruleName : ''

      return React.createElement(
        'div',
        { className: 'dshm_body', 'data-dsh-manual-approval-panel': 'true', 'data-call-id': callId },
        warning !== null
          ? React.createElement(
            'div',
            { className: 'dshm_warn', role: 'alert' },
            React.createElement('span', { className: 'dshm_warnMark' }, '!'),
            React.createElement('span', null, warning),
          )
          : null,
        React.createElement('div', { className: 'dshm_head' }, translate('panel.tool'), React.createElement('code', null, toolName)),
        rows === null
          ? React.createElement('div', { className: 'dshm_label' }, translate('panel.parametersUnavailable'))
          : React.createElement('div', { className: 'dshm_label' }, translate('panel.parameters')),
        rows === null
          ? React.createElement('div', { className: 'dshm_row' }, React.createElement('span', { className: 'dshm_val' }, '…'))
          : renderRows(rows),
        ruleName === '' || warning === null
          ? null
          : React.createElement('div', { className: 'dshm_label' }, translate('panel.warningFromRule', { name: ruleName })),
        React.createElement('div', { className: 'dshm_label' }, translate('panel.feedbackLabel')),
        React.createElement('textarea', {
          className: 'dshm_input',
          rows: 3,
          placeholder: translate('panel.feedbackPlaceholder'),
          'aria-label': translate('panel.feedbackAria'),
          onClick: function (event) { event.stopPropagation() },
          onPointerDown: function (event) { event.stopPropagation() },
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    function el(tag, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [tag, props].concat(children))
    }

    function field(label, control, hint) {
      return el('div', { className: 'dshm_field' },
        el('span', { className: 'dshm_fieldLabel' }, label),
        control,
        hint === undefined || hint === '' ? null : el('span', { className: 'dshm_groupHint' }, hint))
    }

    function textInput(value, onChange, placeholder) {
      return el('input', {
        className: 'dshm_text',
        type: 'text',
        value: value === undefined || value === null ? '' : value,
        placeholder: placeholder === undefined ? '' : placeholder,
        onChange: function (event) { onChange(event.target.value) },
      })
    }

    function textArea(value, onChange, placeholder) {
      return el('textarea', {
        className: 'dshm_area',
        value: value === undefined || value === null ? '' : value,
        placeholder: placeholder === undefined ? '' : placeholder,
        onChange: function (event) { onChange(event.target.value) },
      })
    }

    function select(value, options, onChange) {
      return el('select', {
        className: 'dshm_select',
        value: value,
        onChange: function (event) { onChange(event.target.value) },
      }, options.map(function (option) {
        // `label` carries a locale key, resolved here so a language switch
        // re-labels the control on the next render.
        return el('option', { key: option.value, value: option.value }, translate(option.label))
      }))
    }

    /** A stable id for a new rule, without depending on crypto in old browsers. */
    function newRuleId() {
      return 'rule-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
    }

    function blankRule() {
      return {
        id: newRuleId(),
        name: translate('page.newRule'),
        enabled: false,
        conditions: [{ target: 'toolName', pattern: '' }],
        action: { kind: 'warn', message: '' },
      }
    }

    /** Group badges: condition i contributes `firstGroup..lastGroup` ($1-style). */
    function groupRanges(conditions) {
      var counter = 1
      return conditions.map(function (condition) {
        var pattern = typeof condition.pattern === 'string' ? condition.pattern : ''
        var count = 0
        var inClass = false
        var escaped = false
        for (var index = 0; index < pattern.length; index += 1) {
          var char = pattern.charAt(index)
          if (escaped) { escaped = false; continue }
          if (char === '\\') { escaped = true; continue }
          if (inClass) { if (char === ']') inClass = false; continue }
          if (char === '[') { inClass = true; continue }
          if (char !== '(') continue
          var ahead = pattern.slice(index + 1, index + 4)
          if (ahead.indexOf('?:') === 0 || ahead.indexOf('?=') === 0 || ahead.indexOf('?!') === 0) continue
          if (ahead.indexOf('?<=') === 0 || ahead.indexOf('?<!') === 0) continue
          count += 1
        }
        var range = count === 0 ? null : (count === 1 ? '$' + counter : '$' + counter + '–$' + (counter + count - 1))
        counter += count
        return range
      })
    }

    function RuleEditor(props) {
      var rule = props.rule
      var update = props.update
      var ranges = groupRanges(rule.conditions || [])
      var action = rule.action || { kind: 'warn', message: '' }

      // Every rule starts collapsed: only its name and its one-line summary are
      // shown, so a long list stays scannable and reorderable: only one row is
      // open at a time (opening a card closes the previous one).
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      function patch(next) {
        update(Object.assign({}, rule, next))
      }
      function patchCondition(index, next) {
        var conditions = (rule.conditions || []).slice()
        conditions[index] = Object.assign({}, conditions[index], next)
        patch({ conditions: conditions })
      }
      function patchAction(next) {
        patch({ action: Object.assign({}, action, next) })
      }

      var conditions = (rule.conditions || []).map(function (condition, index) {
        return el('div', { className: 'dshm_cond', key: 'c' + index },
          field(translate('rule.target'), select(condition.target || 'toolName', TARGETS, function (value) {
            patchCondition(index, { target: value })
          })),
          el('div', { className: 'dshm_field dshm_grow' },
            el('span', { className: 'dshm_fieldLabel' }, translate('rule.pattern')),
            textInput(condition.pattern, function (value) { patchCondition(index, { pattern: value }) }, 'e.g. ^pwsh$ or rm\\s+-rf')),
          ranges[index] === null
            ? el('span', { className: 'dshm_groupHint' }, translate('rule.noGroups'))
            : el('span', { className: 'dshm_badge' }, ranges[index]),
          el('button', {
            className: 'dshm_btn dshm_btnDanger',
            type: 'button',
            disabled: (rule.conditions || []).length <= 1,
            onClick: function () {
              var next = (rule.conditions || []).filter(function (_, at) { return at !== index })
              patch({ conditions: next })
            },
          }, translate('rule.remove')),
        )
      })

      var messageLabel = action.kind === 'deny' || action.kind === 'approve' ? translate('rule.reasonOptional') : translate('rule.contentOptional')
      var messageHint = action.kind === 'deny'
        ? 'A rule denial reads exactly like a denial the user typed, so the model cannot tell them apart. Uses $1, $2 … for capture groups.'
        : 'Uses $1, $2 … for capture groups.'

      var actionFields = []
      if (action.kind === 'approve' || action.kind === 'deny') {
        actionFields.push(field(messageLabel, textArr(action.message, function (value) { patchAction({ message: value }) }), messageHint))
      } else if (action.kind === 'warn') {
        actionFields.push(field(translate('rule.warnContent'), textArr(action.message, function (value) { patchAction({ message: value }) }),
          'Shown in red in the approval card. Empty shows: The parameters matched rule "<name>". Uses $1, $2 …'))
      } else if (action.kind === 'judge') {
        actionFields.push(field(translate('rule.url'), textInput(action.url, function (value) { patchAction({ url: value }) }, translate('rule.urlPlaceholder'))))
        actionFields.push(
          el('div', { className: 'dshm_cond' },
            field(translate('rule.method'), textInput(action.method === undefined ? 'POST' : action.method, function (value) { patchAction({ method: value }) }, 'POST')),
            field(translate('rule.timeout'), textInput(action.timeoutMs === undefined ? '10000' : String(action.timeoutMs), function (value) { patchAction({ timeoutMs: value }) }, '10000')),
            field(translate('rule.decisionPath'), textInput(action.decisionPath, function (value) { patchAction({ decisionPath: value }) }, translate('rule.decisionPathPlaceholder'))),
            field(translate('rule.reasonPath'), textInput(action.reasonPath, function (value) { patchAction({ reasonPath: value }) }, translate('rule.reasonPathPlaceholder'))),
          ),
        )
        actionFields.push(field(translate('rule.headers'), textArea(action.headersText, function (value) { patchAction({ headersText: value }) }, 'Authorization: Bearer …')))
        actionFields.push(field(translate('rule.body'), textArea(action.body, function (value) { patchAction({ body: value }) }, 'Defaults to {"<tool>":{"<arg>":"<value>"}}. Uses $1, $2 …')))
        actionFields.push(el('span', { className: 'dshm_hint' },
          'The decision path must resolve to "approve", "deny" or "ask". Any failure — unreachable host, bad status, invalid JSON, missing or unexpected value — falls back to a red warning, and the call still goes to you.'))
      }

      // The collapsed row must still say what the rule does, otherwise a
      // collapsed list is a list of names only.
      var summary = (rule.conditions || []).map(function (condition) {
        var target = translate('target.' + (condition.target || 'toolName'))
        var pattern = typeof condition.pattern === 'string' && condition.pattern !== '' ? condition.pattern : '…'
        return target + ' ≈ ' + pattern
      }).join(translate('rule.summaryJoin'))

      return el('div', { className: 'dshm_card' + (props.invalid ? ' dshm_cardBad' : '') },
        el('div', { className: 'dshm_cardHead' },
          el('label', { className: 'dshm_switch' },
            el('input', {
              type: 'checkbox',
              checked: rule.enabled === true && props.valid !== false,
              disabled: props.valid === false,
              onChange: function (event) { patch({ enabled: event.target.checked }) },
            }),
            translate('rule.enabled')),
          textInput(rule.name, function (value) { patch({ name: value }) }, translate('rule.name')),
          props.invalid
            ? el('span', { className: 'dshm_bad', title: (props.errors || []).join('\n') }, translate('rule.invalidBadge'))
            : el('span', { className: 'dshm_badge' }, translate(ACTION_LABEL[action.kind] || ACTION_LABEL.warn)),
          el('span', { className: 'dshm_grow' }),
          el('button', { className: 'dshm_btn', type: 'button', disabled: props.index === 0, onClick: props.moveUp, title: translate('rule.moveUp') }, '↑'),
          el('button', { className: 'dshm_btn', type: 'button', disabled: props.last, onClick: props.moveDown, title: translate('rule.moveDown') }, '↓'),
          el('button', { className: 'dshm_btn', type: 'button', onClick: props.duplicate }, translate('rule.duplicate')),
          el('button', { className: 'dshm_btn dshm_btnDanger', type: 'button', onClick: props.remove }, translate('rule.delete')),
          el('button', {
            className: 'dshm_btn dshm_btnPrimary dshm_toggle',
            type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function () { setOpen(!open) },
          }, open ? translate('rule.collapse') : translate('rule.expand')),
        ),
        open ? null : el('div', { className: 'dshm_summary' }, summary === '' ? translate('rule.noConditions') : summary),
        open ? null : (props.valid === false
          ? el('ul', { className: 'dshm_errors' }, (props.errors || []).map(function (line, index) {
            return el('li', { key: 'e' + index }, line)
          }))
          : null),
        open ? el('div', { className: 'dshm_editor' },
          el('div', { className: 'dshm_label' }, translate('rule.conditionsHint')),
          conditions,
          el('button', {
            className: 'dshm_btn',
            type: 'button',
            onClick: function () { patch({ conditions: (rule.conditions || []).concat([{ target: 'argValue', pattern: '' }]) }) },
          }, translate('rule.addCondition')),
          el('div', { className: 'dshm_label' }, translate('rule.action')),
          field(translate('rule.action'), select(action.kind || 'warn', ACTIONS, function (value) {
            patch({ action: Object.assign({}, action, { kind: value }) })
          })),
          actionFields,
          props.invalid
            ? null
            : el('span', { className: 'dshm_groupHint' }, (rule.groupCount || 0) === 0
              ? translate('rule.capturesNone')
              : 'This rule exposes $1 … $' + rule.groupCount + ' to its message.'),
          el('span', { className: 'dshm_hint' }, translate('rule.collapseHint')),
        ) : null,
      )
    }

    /** A textarea-typed variant used for multi-line action messages. */
    function textArr(value, onChange) {
      return textArea(value, onChange, '')
    }

    function RulesSection() {
      var state = React.useState({ loading: true, masterEnabled: true, rules: [], compiled: [], errors: [], path: '' })
      var model = state[0]
      var setModel = state[1]
      var statusState = React.useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      var dirtyState = React.useState(false)
      var dirty = dirtyState[0]
      var setDirty = dirtyState[1]

      function load() {
        var globals = pageGlobals()
        if (globals.token === '' || globals.rulesEndpoint === '') {
          setModel(function (previous) { return Object.assign({}, previous, { loading: false, errors: [translate('page.endpointUnavailable')] }) })
          return
        }
        request(globals.rulesEndpoint + RULES_QUERY)
          .then(function (payload) {
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              setModel(function (previous) { return Object.assign({}, previous, { loading: false, errors: [String(payload && payload.error) || translate('page.loadFailed')] }) })
              return
            }
            setModel({
              loading: false,
              masterEnabled: payload.masterEnabled !== false,
              rules: Array.isArray(payload.rules) ? payload.rules : [],
              compiled: Array.isArray(payload.compiled) ? payload.compiled : [],
              errors: Array.isArray(payload.errors) ? payload.errors : [],
              path: typeof payload.path === 'string' ? payload.path : '',
            })
            setDirty(false)
          })
          .catch(function (error) {
            setModel(function (previous) { return Object.assign({}, previous, { loading: false, errors: [String(error && error.message) || translate('page.loadFailed')] }) })
          })
      }

      React.useEffect(function () {
        load()
        return function () {}
      }, [])

      function save() {
        var globals = pageGlobals()
        if (globals.token === '' || globals.rulesEndpoint === '') return
        setStatus(translate('page.saving'))
        request(globals.rulesEndpoint, {
          method: 'POST',
          body: {
            rules: {
              version: 1,
              masterEnabled: model.masterEnabled,
              rules: model.rules,
            },
          },
        }).then(function (payload) {
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setStatus(translate('page.saveFailed', { error: String(payload && payload.error) || translate('page.unknownError') }))
            return
          }
          setModel(function (previous) {
            return Object.assign({}, previous, {
              compiled: Array.isArray(payload.compiled) ? payload.compiled : previous.compiled,
              errors: Array.isArray(payload.errors) ? payload.errors : [],
            })
          })
          var invalid = (payload.compiled || []).filter(function (entry) { return entry.valid !== true }).length
          setStatus(invalid === 0 ? translate('page.saved') : translate('page.savedWithInvalid', { count: invalid }))
          setDirty(false)
        }).catch(function (error) {
          setStatus(translate('page.saveFailed', { error: String(error && error.message) || translate('page.unknownError') }))
        })
      }

      function updateRule(index, next) {
        setModel(function (previous) {
          var rules = previous.rules.slice()
          rules[index] = next
          return Object.assign({}, previous, { rules: rules })
        })
        setDirty(true)
      }

      function moveRule(index, delta) {
        setModel(function (previous) {
          var target = index + delta
          if (target < 0 || target >= previous.rules.length) return previous
          var rules = previous.rules.slice()
          var moved = rules.splice(index, 1)[0]
          rules.splice(target, 0, moved)
          return Object.assign({}, previous, { rules: rules })
        })
        setDirty(true)
      }

      function addRule() {
        setModel(function (previous) { return Object.assign({}, previous, { rules: previous.rules.concat([blankRule()]) }) })
        setDirty(true)
      }

      if (model.loading) return el('div', { className: 'dshm_page' }, el('div', { className: 'dshm_empty' }, translate('page.loading')))

      var compiledByIndex = {}
      model.compiled.forEach(function (entry) { compiledByIndex[entry.index] = entry })

      return el('div', { className: 'dshm_page' },
        el('div', { className: 'dshm_pageHead' },
          el('div', { className: 'dshm_title' }, translate('page.title')),
          el('div', { className: 'dshm_hint' }, translate('page.intro')),
          model.path === '' ? null : el('div', { className: 'dshm_hint' }, translate('page.storedAt', { path: model.path })),
        ),
        (model.errors || []).length === 0
          ? null
          : el('ul', { className: 'dshm_errors' }, model.errors.map(function (line, index) { return el('li', { key: 'x' + index }, line) })),
        el('div', { className: 'dshm_bar' },
          el('label', { className: 'dshm_switch' },
            el('input', {
              type: 'checkbox',
              checked: model.masterEnabled,
              onChange: function (event) {
                var checked = event.target.checked
                setModel(function (previous) { return Object.assign({}, previous, { masterEnabled: checked }) })
                setDirty(true)
              },
            }),
            translate('page.masterOn')),
          el('span', { className: 'dshm_hint' }, translate('page.masterHint')),
          el('span', { className: 'dshm_grow' }),
          status === '' ? null : el('span', { className: dirty ? 'dshm_hint' : 'dshm_ok' }, status),
          el('button', { className: 'dshm_btn', type: 'button', onClick: load }, translate('page.reload')),
          el('button', { className: 'dshm_btn dshm_btnPrimary', type: 'button', disabled: !dirty, onClick: save }, dirty ? translate('page.save') : translate('page.saved')),
        ),
        el('div', { className: 'dshm_bar' },
          el('button', { className: 'dshm_btn', type: 'button', onClick: addRule }, translate('page.addRule')),
          el('span', { className: 'dshm_hint' }, translate('page.ruleCount', { count: model.rules.length })),
        ),
        model.rules.length === 0
          ? el('div', { className: 'dshm_empty' }, translate('page.empty'))
          : model.rules.map(function (rule, index) {
            var compiled = compiledByIndex[index]
            return el(RuleEditor, {
              key: rule.id === undefined ? 'r' + index : String(rule.id),
              rule: rule,
              index: index,
              last: index === model.rules.length - 1,
              invalid: compiled !== undefined && compiled.valid !== true,
              valid: compiled === undefined ? undefined : compiled.valid,
              errors: compiled === undefined ? [] : compiled.errors,
              groupCount: compiled === undefined ? 0 : compiled.groupCount,
              update: function (next) { updateRule(index, next) },
              moveUp: function () { moveRule(index, -1) },
              moveDown: function () { moveRule(index, 1) },
              duplicate: function () {
                var copy = JSON.parse(JSON.stringify(rule))
                copy.id = newRuleId()
                copy.name = String(rule.name || 'Rule') + translate('page.copySuffix')
                setModel(function (previous) {
                  var rules = previous.rules.slice()
                  rules.splice(index + 1, 0, copy)
                  return Object.assign({}, previous, { rules: rules })
                })
                setDirty(true)
              },
              remove: function () {
                setModel(function (previous) {
                  return Object.assign({}, previous, { rules: previous.rules.filter(function (_, at) { return at !== index }) })
                })
                setDirty(true)
              },
            })
          }),
      )
    }

    // ---------------------------------------------------------------------
    // Install
    // ---------------------------------------------------------------------

    /**
     * Register this plugin's dictionaries and bind a translator.
     *
     * Best-effort for the same reason as slot registration: the client plugin
     * tree loads as a unit, so a locale failure must cost only the labels. With
     * no locale service the English dictionary still answers.
     */
    function bindTranslator(ctx) {
      var locale = ctx.get('locale')
      var english = function (key, params) {
        return interpolate(DICT.en[key] === undefined ? key : DICT.en[key], params)
      }
      if (locale === undefined || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        return english
      }
      try {
        ctx.effect(() => locale.register(NS, 'en', DICT.en), 'manual-approval: en copy')
        ctx.effect(() => locale.register(NS, 'zh', DICT.zh), 'manual-approval: zh copy')
      } catch (error) {
        warn('could not register translations: ' + describeError(error))
        return english
      }
      try {
        var bound = locale.bind(NS)
        return function (key, params) {
          var text = bound(key, params)
          // The service shows the raw key when nothing matches; prefer English
          // over leaking a key into the UI.
          if (text === key && DICT.en[key] !== undefined) return interpolate(DICT.en[key], params)
          return text
        }
      } catch (error) {
        warn('could not bind translations: ' + describeError(error))
        return english
      }
    }

    function apply(ctx) {
      // Every side effect below is individually guarded: the client plugin tree
      // loads as a unit, so one failure must cost only this plugin's feature.
      setTranslator(bindTranslator(ctx))
      try {
        upsertStyle(document)
      } catch (error) {
        warn('could not install styles: ' + describeError(error))
      }
      var disposers = []
      try {
        disposers.push(installCommitOnDecision(document))
      } catch (error) {
        warn('could not install the feedback listener: ' + describeError(error))
      }
      var slots = ctx.get('slots')
      if (slots === undefined) {
        return function () {
          for (var index = 0; index < disposers.length; index += 1) disposers[index]()
        }
      }

      /**
       * Register one contribution, never letting a rejection escape.
       *
       * The client plugin tree loads as a unit: an error thrown from `apply`
       * fails THIS plugin's entry, and the harness then reports the whole tree as
       * failed to load — other plugins included. A detail panel that cannot
       * register (a priority collision, a changed slot contract) must therefore
       * cost only the panel, never the harness.
       */
      function contribute(slotKey, options, component) {
        try {
          var dispose = slots.inject(slotKey, function () {
            return slots.register(options, component)
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          warn('could not contribute to ' + slotKey + ': ' + describeError(error))
        }
      }

      // `conversation.approval.detail` is a SINGLE slot and the shipped chat UI
      // already registers its own command preview there at the default priority
      // 0. Registering at 0 collides, and the collision is reported as a failure
      // of THAT plugin's entry — which is how this panel first broke
      // `@deepseek-ai/dsh-client-ui-chat`. The slot's own error text names the
      // remedy: a different priority shadows it, and the LOWEST renders. -1
      // takes the seam deterministically instead of depending on load order.
      //
      // What is shadowed is one line of command text; this panel shows the same
      // argument plus the full argument list, the rule warning and the feedback
      // box, so nothing load-bearing is lost.
      contribute(SLOT_DETAIL, { name: SLOT_DETAIL, priority: DETAIL_PRIORITY }, ManualApprovalDetail)
      // A thunk, not a pre-evaluated string: `settings.section` accepts
      // `label: string | (() => string)`, and a fixed string would freeze the
      // first language this page happened to render in.
      contribute(SLOT_SETTINGS, { name: SLOT_SETTINGS, id: SETTINGS_SECTION_ID, order: 40, label: function () { return translate('page.title') } }, RulesSection)

      return function () {
        for (var index = 0; index < disposers.length; index += 1) {
          var dispose = disposers[index]
          if (typeof dispose === 'function') dispose()
        }
        disposers = []
      }
    }

    exports.apply = apply
    exports.inject = inject
    /**
     * Exposed for the test suite, which checks that both dictionaries carry the
     * same keys and that the Chinese copy is genuinely translated. Not part of
     * the plugin contract; the module system ignores unknown exports.
     */
    exports.__dict = DICT
    return module.exports
  },
})
