# opencode-homeassistant

An [OpenCode](https://opencode.ai) plugin that sends agent status to [Home Assistant](https://www.home-assistant.io) via webhooks -- and optionally lets you respond to permission requests from HA.

## Features

- Notifies Home Assistant when the OpenCode agent becomes busy, idle, waiting, or encounters an error
- Sends the hostname alongside the state, so you can identify which machine triggered the automation
- Tracks session duration -- `idle`, `waiting`, and `error` payloads include `durationMs` (time since the last `busy` event)
- Flushes pending webhooks when OpenCode exits, including a final `idle` update for active sessions
- Automatically cleans up sessions stuck in `busy` state after 10 minutes of no activity, checked every minute
- Per-state webhook routing -- send different states to different webhook IDs
- Multiple webhook targets -- send the same state to several Home Assistant instances
- Includes question choices in `waiting` payloads -- HA can render actionable notifications with the available options
- Remote permission response -- approve or deny agent permissions from HA (via entity polling)
- Hot-reloads configuration when OpenCode's config changes (no restart needed)
- JSON payload, compatible with Home Assistant's webhook trigger out of the box

## States

Requires OpenCode 1.15.11 or later so terminal webhooks can be flushed during plugin shutdown.

| State     | OpenCode Event / Hook        | Condition                | Description                             |
| --------- | ---------------------------- | ------------------------ | --------------------------------------- |
| `busy`    | `event` → `session.status`   | `status.type === 'busy'` | Agent starts processing                 |
| `idle`    | `event` → `session.status`   | `status.type === 'idle'` | Agent finishes and is waiting for input |
| `waiting` | `event` → `permission.asked` |                          | Agent requests user permission          |
| `waiting` | `tool.execute.before`        | `tool === 'question'`    | Agent asks the user a question          |
| `error`   | `event` → `session.error`    |                          | Session encounters an error             |

## Payload

The plugin sends a `POST` request with `Content-Type: application/json`:

```json
{
  "state": "idle",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "01JFF...",
  "durationMs": 12345
}
```

| Field        | Description                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `state`      | One of `busy`, `idle`, `waiting`, `error`                                   |
| `hostname`   | Machine hostname (`os.hostname()`)                                          |
| `project`    | Directory name of the current project                                       |
| `sessionId`  | OpenCode session ID (useful for correlating events)                         |
| `durationMs` | Milliseconds since the session became `busy` (omitted from `busy` payloads) |
| `waiting`    | Details about what the agent is waiting for (only on `waiting` payloads)    |

### `waiting` object

| Field       | Description                                                                      |
| ----------- | -------------------------------------------------------------------------------- |
| `reason`    | Either `permission` (agent needs approval) or `question` (agent asks a question) |
| `id`        | Permission ID or question request ID, used for remote replies                    |
| `type`      | Permission type, e.g. `bash`, `edit`, `webfetch` (only for `permission`)         |
| `title`     | Human-readable description of the request                                        |
| `pattern`   | The command or path pattern being requested (only for `permission`)              |
| `questions` | Array of question details with options (only for `question`)                     |

In a Home Assistant automation, access these values via `trigger.json.*`, e.g. `trigger.json.state`.

### Permission payload example

```json
{
  "state": "waiting",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "ses_...",
  "durationMs": 4200,
  "waiting": {
    "reason": "permission",
    "id": "per_cd77d4766001...",
    "type": "bash",
    "title": "bash: mkdir test-folder",
    "pattern": ["mkdir test-folder"]
  }
}
```

### Question payload example

```json
{
  "state": "waiting",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "ses_...",
  "durationMs": 5000,
  "waiting": {
    "reason": "question",
    "id": "que_014e8b5fe001...",
    "title": "Choose framework",
    "questions": [
      {
        "header": "Choose framework",
        "question": "Which framework would you like to use?",
        "options": [
          { "label": "React", "description": "Component-based UI library" },
          { "label": "Vue", "description": "Progressive framework" }
        ],
        "multiple": false
      }
    ]
  }
}
```

Each question in the `questions` array has:

| Field      | Type       | Description                                 |
| ---------- | ---------- | ------------------------------------------- |
| `header`   | `string`   | Short label (max 30 chars)                  |
| `question` | `string`   | Full question text                          |
| `options`  | `array`    | Available choices (`label` + `description`) |
| `multiple` | `boolean?` | Whether multiple selections are allowed     |

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-homeassistant"]
}
```

## Configuration

Create `~/.config/opencode/opencode-homeassistant.json`:

```json
{
  "webhookUrl": "https://your-home-assistant/api/webhook/your_webhook_id"
}
```

The config file path can be overridden with the `OPENCODE_HA_CONFIG_PATH` environment variable. See [webhook trigger documentation at Home Assistant](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger).

If no webhook URLs are configured or the config file is missing, the plugin is disabled silently.

The configuration is hot-reloaded whenever OpenCode's config changes -- no restart needed.

### Per-state webhook routing

Use `webhookUrls` to send different states to different webhook IDs. A `default` key acts as a fallback for any state without its own entry:

```json
{
  "webhookUrls": {
    "busy": "https://ha.local/api/webhook/opencode_busy",
    "error": "https://ha.local/api/webhook/opencode_error",
    "default": "https://ha.local/api/webhook/opencode_general"
  }
}
```

With this config, `busy` and `error` events go to their own webhooks while `idle` and `waiting` fall back to the `default` webhook.

### Multiple webhook targets

Each entry in `webhookUrls` can be a single URL or an array, allowing you to notify multiple Home Assistant instances or trigger several automations at once:

```json
{
  "webhookUrls": {
    "default": [
      "https://ha-home.local/api/webhook/opencode_status",
      "https://ha-office.local/api/webhook/opencode_status"
    ],
    "error": "https://ha-home.local/api/webhook/opencode_errors"
  }
}
```

### Precedence

The plugin resolves webhook URLs in this order:

1. `webhookUrls[state]` -- exact match for the current state
2. `webhookUrls.default` -- fallback for unmatched states
3. `webhookUrl` -- legacy single-URL config (used when `webhookUrls` is absent)

### Remote permission response

The plugin can relay permission responses from Home Assistant back to OpenCode. When a `permission.asked` event fires, the plugin sends the webhook **and** starts polling an HA entity for a response. If the user answers the permission locally in the TUI, the poll aborts immediately.

To enable this, add the following to your config:

```json
{
  "webhookUrl": "https://ha.local/api/webhook/opencode_status",
  "haApiUrl": "https://ha.local/api",
  "haToken": "${HA_LONG_LIVED_TOKEN}",
  "permissionResponseEntity": "input_text.opencode_permission_response",
  "permissionTimeout": 120
}
```

| Field                      | Default                                   | Description                                               |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `haApiUrl`                 | _(required)_                              | Home Assistant REST API base URL                          |
| `haToken`                  | _(required)_                              | Long-lived access token (supports `${ENV_VAR}` expansion) |
| `permissionResponseEntity` | `input_text.opencode_permission_response` | Entity the plugin polls for the user's response           |
| `permissionTimeout`        | `120`                                     | Seconds to wait for a response before giving up           |

**How it works:**

1. Plugin sends the `waiting` webhook (with `waiting.id` set to the permission ID or question request ID)
2. Plugin starts polling `permissionResponseEntity` every 2 seconds
3. HA automation shows an actionable notification; when the user taps an action, the automation sets the entity state (see formats below)
4. Plugin reads the response, clears the entity, and replies to OpenCode
5. If the user answers locally in the TUI instead, the plugin receives a `permission.replied` / `question.replied` event and stops polling immediately

**Response formats**

The entity value is disambiguated by splitting on `:`. A first segment of `question` marks a question response (3 segments); anything else is a permission response (2 segments).

| Kind       | Format                               | Example                 |
| ---------- | ------------------------------------ | ----------------------- |
| Permission | `<permissionId>:<response>`          | `per_abc123:allow`      |
| Question   | `question:<requestId>:<optionIndex>` | `question:que_xyz789:0` |

Valid permission responses: `allow`, `always`, `deny`.

`<optionIndex>` is a 0-based index into `questions[0].options` -- the same array sent in the `waiting` payload. An index is used rather than the label because labels may contain `:`, carry emoji, or exceed the `input_text` 255-character limit. If the index is out of range or unparsable, the plugin sends no reply rather than a malformed answer.

Notes and limits:

- Only `questions[0]` is answered. Multi-question requests are not supported.
- Exactly one label is sent, since iOS notification actions are single-tap; `multiple: true` is not supported.
- `custom: true` ("Type your own answer") is not representable, as HA builds buttons from `options` only.
- HA should clear the entity shortly after setting it (5 seconds is a good default) to stop stale values latching. The 2-second poll interval sits comfortably inside that window -- do not raise it much beyond 2s without widening the reset delay.

## Automation ideas

### Busy light / desk LED

Change the color of a smart bulb or LED strip based on agent state -- red for errors, yellow for waiting on input, green for busy, off when idle:

```yaml
automation:
  - alias: OpenCode busy light
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    actions:
      - choose:
          - conditions: "{{ trigger.json.state == 'busy' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: green
                  brightness: 128
          - conditions: "{{ trigger.json.state == 'waiting' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: yellow
                  brightness: 200
          - conditions: "{{ trigger.json.state == 'error' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: red
                  brightness: 255
          - conditions: "{{ trigger.json.state == 'idle' }}"
            sequence:
              - action: light.turn_off
                target:
                  entity_id: light.desk_led
```

### Track agent status as a template sensor (with multi-session support)

A [trigger-based template sensor](https://www.home-assistant.io/integrations/template/#trigger-based-template-sensors) gives you a rich entity with attributes and derived state logic. This version tracks multiple concurrent sessions -- one session going idle won't overwrite the state of another still-busy session:

```yaml
template:
  - trigger:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: true
      - trigger: event
        event_type: timer.finished
        event_data:
          entity_id: timer.opencode_agent_state
    sensor:
      - name: OpenCode Agent Status
        unique_id: opencode_agent_status
        device_class: enum
        state: >
          {%- if trigger.platform == 'event' -%}
            idle
          {%- else -%}
            {%- set prev = this.attributes.get('sessions', {}) -%}
            {%- set sid = trigger.json.sessionId | default('unknown') -%}
            {%- set raw = trigger.json.state -%}
            {%- set was_busy_long = raw == 'idle'
                   and prev.get(sid, {}).get('state') == 'busy'
                   and (trigger.json.durationMs | default(0) | int) >= 10000 -%}
            {%- set effective = 'completed' if was_busy_long else raw -%}
            {%- set ns = namespace(states=[]) -%}
            {%- for k, v in prev.items() if k != sid and v.state != 'idle' -%}
              {%- set ns.states = ns.states + [v.state] -%}
            {%- endfor -%}
            {%- if effective != 'idle' -%}
              {%- set ns.states = ns.states + [effective] -%}
            {%- endif -%}
            {%- if ns.states | length == 0 -%}
              {{ effective }}
            {%- else -%}
              {%- set prio = {'error': 0, 'waiting': 1, 'busy': 2, 'completed': 3} -%}
              {%- set ns2 = namespace(best='idle', best_prio=99) -%}
              {%- for s in ns.states -%}
                {%- if prio.get(s, 50) < ns2.best_prio -%}
                  {%- set ns2.best = s -%}
                  {%- set ns2.best_prio = prio.get(s, 50) -%}
                {%- endif -%}
              {%- endfor -%}
              {{ ns2.best }}
            {%- endif -%}
          {%- endif -%}
        icon: >
          {%- set icons = {
            'busy': 'mdi:robot-outline',
            'waiting': 'mdi:robot-confused-outline',
            'error': 'mdi:robot-dead-outline',
            'completed': 'mdi:robot-happy-outline',
          } -%}
          {{ icons.get(this.state, 'mdi:robot-off-outline') }}
        attributes:
          sessions: >
            {%- if trigger.platform == 'event' -%}
              {}
            {%- else -%}
              {%- set prev = this.attributes.get('sessions', {}) -%}
              {%- set sid = trigger.json.sessionId | default('unknown') -%}
              {%- set raw = trigger.json.state -%}
              {%- set ns = namespace(sessions={}) -%}
              {%- for k, v in prev.items() if k != sid and v.state != 'idle' -%}
                {%- set ns.sessions = dict(ns.sessions, **{k: v}) -%}
              {%- endfor -%}
              {%- set was_busy_long = raw == 'idle'
                     and prev.get(sid, {}).get('state') == 'busy'
                     and (trigger.json.durationMs | default(0) | int) >= 10000 -%}
              {%- set effective = 'completed' if was_busy_long else raw -%}
              {%- if effective != 'idle' -%}
                {%- set entry = {
                  'state': effective,
                  'hostname': trigger.json.hostname | default(''),
                  'project': trigger.json.project | default(''),
                } -%}
                {%- set ns.sessions = dict(ns.sessions, **{sid: entry}) -%}
              {%- endif -%}
              {{ ns.sessions | to_json }}
            {%- endif -%}
          hostname: >
            {%- if trigger.platform == 'webhook' -%}
              {{ trigger.json.hostname }}
            {%- else -%}
              {{ this.attributes.get('hostname', '') }}
            {%- endif -%}
          project: >
            {%- if trigger.platform == 'webhook' -%}
              {{ trigger.json.project | default('') }}
            {%- else -%}
              {{ this.attributes.get('project', '') }}
            {%- endif -%}
          session_id: >
            {%- if trigger.platform == 'webhook' -%}
              {{ trigger.json.sessionId | default('') }}
            {%- else -%}
              {{ this.attributes.get('session_id', '') }}
            {%- endif -%}
          duration_ms: >
            {%- if trigger.platform == 'webhook' -%}
              {{ trigger.json.durationMs | default(none) }}
            {%- else -%}
              {{ this.attributes.get('duration_ms', none) }}
            {%- endif -%}
          waiting_reason: >
            {%- if trigger.platform == 'webhook' and trigger.json.waiting is defined -%}
              {{ trigger.json.waiting.reason | default(none) }}
            {%- elif trigger.platform == 'webhook' -%}
              {{ none }}
            {%- else -%}
              {{ this.attributes.get('waiting_reason', none) }}
            {%- endif -%}
          waiting_title: >
            {%- if trigger.platform == 'webhook' and trigger.json.waiting is defined -%}
              {{ trigger.json.waiting.title | default(none) }}
            {%- elif trigger.platform == 'webhook' -%}
              {{ none }}
            {%- else -%}
              {{ this.attributes.get('waiting_title', none) }}
            {%- endif -%}
          permission_id: >
            {%- if trigger.platform == 'webhook' and trigger.json.waiting is defined -%}
              {{ trigger.json.waiting.id | default(none) }}
            {%- elif trigger.platform == 'webhook' -%}
              {{ none }}
            {%- else -%}
              {{ this.attributes.get('permission_id', none) }}
            {%- endif -%}
          question_options: >
            {%- if trigger.platform == 'webhook' and trigger.json.waiting is defined
                  and trigger.json.waiting.questions is defined
                  and trigger.json.waiting.questions | length > 0
                  and trigger.json.waiting.questions[0].options is defined -%}
              {{ trigger.json.waiting.questions[0].options | to_json }}
            {%- elif trigger.platform == 'webhook' -%}
              []
            {%- else -%}
              {{ this.attributes.get('question_options', []) | to_json }}
            {%- endif -%}

timer:
  opencode_agent_state:
    name: OpenCode agent state auto-revert
    duration: '00:00:05'

automation:
  - alias: OpenCode agent state timer control
    mode: restart
    triggers:
      - trigger: state
        entity_id: sensor.opencode_agent_status
    actions:
      - if:
          - condition: state
            entity_id: sensor.opencode_agent_status
            state: [error, completed]
        then:
          - action: timer.start
            target:
              entity_id: timer.opencode_agent_state
        else:
          - action: timer.cancel
            target:
              entity_id: timer.opencode_agent_state
```

The aggregate state reflects the highest-priority active session (`error` > `waiting` > `busy` > `completed` > `idle`). The `sessions` attribute stores a dict of active sessions keyed by `sessionId`, each with `state`, `hostname`, and `project`.

The `completed` state is synthesized when the agent goes from `busy` → `idle` after at least 10 seconds -- a signal that a real task finished. The timer ensures transient states (`error`, `completed`) auto-revert to `idle` after 5 seconds. The `waiting_*` and `permission_id` attributes are cleared when a non-waiting webhook arrives, preventing stale values.

### Actionable mobile notification when waiting for input

Get a push notification with action buttons when the agent has been busy for a while (>30s) and then needs your input. This uses a **separate webhook** so it works independently of the sensor and correctly handles parallel sessions.

**Plugin config** -- route `waiting` payloads to both the sensor and the notification webhook:

```json
{
  "webhookUrls": {
    "default": "https://ha.local/api/webhook/opencode_agent_status",
    "waiting": [
      "https://ha.local/api/webhook/opencode_agent_status",
      "https://ha.local/api/webhook/opencode_agent_notify"
    ]
  }
}
```

Since `webhookUrls[state]` overrides `default` entirely, the `waiting` entry must include the sensor webhook too.

**HA automation** -- triggers on the notification webhook, reads all data from the payload:

```yaml
input_text:
  opencode_permission_response:
    name: OpenCode Permission Response
    initial: ''
    max: 255

automation:
  - alias: Notify when OpenCode needs input after long-running prompt
    mode: parallel
    max: 10
    triggers:
      - trigger: webhook
        webhook_id: opencode_agent_notify
        allowed_methods:
          - POST
        local_only: true
    conditions:
      - condition: template
        value_template: >
          {{ trigger.json.state == 'waiting'
             and (trigger.json.durationMs | default(0) | int) >= 30000 }}
    actions:
      - variables:
          waiting: '{{ trigger.json.waiting | default({}) }}'
          waiting_reason: "{{ waiting.reason | default('') }}"
          is_permission: "{{ waiting_reason == 'permission' }}"
          is_question: "{{ waiting_reason == 'question' }}"
          permission_id: "{{ waiting.id | default('') }}"
          question_options: >
            {%- if waiting.questions is defined
                  and waiting.questions | length > 0
                  and waiting.questions[0].options is defined -%}
              {{ waiting.questions[0].options }}
            {%- else -%}
              []
            {%- endif -%}
          action_approve: "{{ 'APPROVE_' ~ context.id }}"
          action_deny: "{{ 'DENY_' ~ context.id }}"
          action_always: "{{ 'ALWAYS_' ~ context.id }}"
      - variables:
          notification_message: >
            {{ trigger.json.project | default('unknown') }}
            on {{ trigger.json.hostname | default('unknown') }}
            {%- if waiting.title not in [none, ''] %}
            — {{ waiting.title }}
            {%- endif %}
          question_actions: >
            {%- set opts = question_options if question_options is list else [] -%}
            {%- set ns = namespace(actions=[]) -%}
            {%- for opt in opts[:10] -%}
              {%- set ns.actions = ns.actions + [{"action": "OPT_" ~ loop.index0 ~ "_" ~ context.id, "title": opt.label}] -%}
            {%- endfor -%}
            {{ ns.actions }}
      - choose:
          - alias: Permission notification
            conditions: '{{ is_permission }}'
            sequence:
              - action: notify.mobile_app_your_phone
                data:
                  title: opencode is waiting for input
                  message: '{{ notification_message }}'
                  data:
                    push:
                      interruption-level: time-sensitive
                    actions:
                      - action: '{{ action_approve }}'
                        title: Approve
                      - action: '{{ action_deny }}'
                        title: Deny
                        destructive: true
                      - action: '{{ action_always }}'
                        title: Always Allow
              - wait_for_trigger:
                  - trigger: event
                    event_type: mobile_app_notification_action
                    event_data:
                      action: '{{ action_approve }}'
                  - trigger: event
                    event_type: mobile_app_notification_action
                    event_data:
                      action: '{{ action_deny }}'
                  - trigger: event
                    event_type: mobile_app_notification_action
                    event_data:
                      action: '{{ action_always }}'
                timeout: '00:02:00'
                continue_on_timeout: true
              - choose:
                  - alias: Approve
                    conditions: '{{ wait.trigger is defined and wait.trigger.event.data.action == action_approve }}'
                    sequence:
                      - action: input_text.set_value
                        target:
                          entity_id: input_text.opencode_permission_response
                        data:
                          value: '{{ permission_id }}:allow'
                  - alias: Always Allow
                    conditions: '{{ wait.trigger is defined and wait.trigger.event.data.action == action_always }}'
                    sequence:
                      - action: input_text.set_value
                        target:
                          entity_id: input_text.opencode_permission_response
                        data:
                          value: '{{ permission_id }}:always'
                  - alias: Deny
                    conditions: '{{ wait.trigger is defined and wait.trigger.event.data.action == action_deny }}'
                    sequence:
                      - action: input_text.set_value
                        target:
                          entity_id: input_text.opencode_permission_response
                        data:
                          value: '{{ permission_id }}:deny'
          - alias: Question notification with options
            conditions: '{{ is_question and question_actions | length > 0 }}'
            sequence:
              - action: notify.mobile_app_your_phone
                data:
                  title: opencode is waiting for input
                  message: '{{ notification_message }}'
                  data:
                    push:
                      interruption-level: time-sensitive
                    actions: '{{ question_actions }}'
        default:
          - action: notify.mobile_app_your_phone
            data:
              title: opencode is waiting for input
              message: '{{ notification_message }}'
              data:
                push:
                  interruption-level: time-sensitive
```

Key design choices:

- **Dedicated webhook** (`opencode_agent_notify`) -- the automation triggers directly from the webhook payload, not from sensor state changes. This avoids race conditions when multiple sessions are active and ensures `durationMs` is accurate per-session.
- **`mode: parallel`** -- multiple concurrent sessions can each have their own notification in-flight.
- **`durationMs >= 30000`** -- uses the plugin's per-session busy timer instead of HA's `last_changed`, which can be inaccurate when sessions overlap.
- **Permission reply** -- tapping Approve/Deny writes to `input_text.opencode_permission_response` using the format `<permissionId>:<response>`, which the plugin polls for.
- **Question actions** -- dynamically builds notification buttons from the question's options (up to 10, the iOS limit). Tapping one writes `question:<requestId>:<optionIndex>` to the same entity; the plugin resolves the index back to the option label and replies to OpenCode.

### Session duration tracking

Log how long each agent interaction took. The `durationMs` field is included in `idle`, `waiting`, and `error` payloads, measuring the time since the session last became `busy`:

```yaml
automation:
  - alias: OpenCode session duration
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    conditions:
      - condition: template
        value_template: '{{ trigger.json.durationMs is defined }}'
    actions:
      - action: input_number.set_value
        target:
          entity_id: input_number.opencode_last_duration_seconds
        data:
          value: '{{ (trigger.json.durationMs / 1000) | round(1) }}'
```

## License

[MIT](LICENSE)
