# opencode-cache-coach

An [OpenCode](https://opencode.ai) plugin that coaches you on making better use of your tokens.
It connects token usage and estimated costs to practical choices: when to compact, which model to
compact on, and how to avoid carrying oversized tool results through the rest of a session.

Your conversation and tool results become input to later requests. Prompt caching makes reusing
that context cheaper, but switching models, letting the cache expire, or crossing a higher-price
context threshold can make the next request more expensive. Cache Coach explains these trade-offs
as you work, with cost comparisons and suggestions based on your session and model prices.

The cache indicator and `/cache` details show where you stand. Tips and expiry messages help you
decide what to do next, such as compacting while the cache is warm or using a cheaper model when
the context must be written again.

Requires OpenCode 2.2 or later.

## Installation

```bash
opencode plugin add opencode-cache-coach
```

This adds the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-cache-coach"]
}
```

The CLI part shows the indicator, tips, and expiry messages. The server part only keeps the expiry
messages out of model requests.

## Cache indicator

The prompt footer shows the cache state of the session on screen:

| Footer                                 | Meaning                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `● cache 3:42`                         | Warm. The next message reads the context from the cache.                 |
| `◐ cache 0:45`                         | Warm, with less than a minute left.                                      |
| `● cache`                              | A request is running and using the cache.                                |
| `○ cache cold · rewrite ~180K ($0.90)` | Expired, or another model is selected. The next message writes it again. |
| `○ cache cold · … · GPT-6.1 Sol $0.45` | As above, and compacting on your `compactionModel` costs less.           |
| `● cache 3:42 · warming?`              | Warm, in a session that OpenCode warms. See [Warming](#warming).         |

The footer stays empty until the session has a request whose provider reports cache tokens. Click
the indicator, or run `/cache`, to see the last request's cache hit rate, what the next message
costs, and the session's cost so far.

The countdown starts when the last request started, and uses the cache lifetime from the model's
or provider's `cache.ttl` setting, or 5 minutes. Providers can evict a cache earlier, so a warm
indicator means the cache is likely warm.

### Warming

When OpenCode's [`warming`](https://opencode.ai/docs/warming/) option covers a session, OpenCode
sends keep-alive requests while you're idle. Those requests add no messages, and the plugin can't
see whether they renew the cache. With GitLab Duo models, requests after a keep-alive request still
missed the cache in testing. So the countdown doesn't count on warming, and ends in `· warming?` to
show that the cache might last longer.

The plugin reads the `warming` setting from the top level of your configuration and from the
model's or provider's `settings.cache.warming`, once per directory. Restart OpenCode after you
change `warming`.

## Expiry messages

Shortly before the cache of a large context expires, the plugin adds a message to the session, so
it's the last thing you see when you come back:

```text
◈ Prompt cache expires at 14:32. After that, the next message writes ~225K tokens to the cache
  again (~$1.13 on Claude Opus 5.5). To compact, switch to GPT-6.1 Sol first (~$0.56), run
  /compact, then switch back.
```

A compaction after the cache expires writes the whole context again, so compacting on a cheaper
model saves most of that cost. Set `compactionModel` to name the model. Without it, the message
only says that a cheaper model costs less.

The message appears once each time the session goes idle, in top-level sessions whose last request
the TUI saw finish, and only when the next message writes at least `minTokens` and costs at least
`minCost`. The server part removes these messages from every model request, so the model never
sees them and the cache isn't affected.

## Tips

The plugin shows a toast when it spots one of these patterns. Each tip appears at most once per
session, except the model-switch tips, which appear for every switch away from a new request:

- **Model switch on a warm cache.** Selecting another model for a large context means the next
  message writes it to a new cache. The tip compares that with staying on the current model and
  suggests compacting first.
- **Model switch after the cache expired.** The next message writes the context again on any model,
  so the tip says when the new model, or your `compactionModel`, can compact it for less.
- **Close to the context ceiling.** At 80% of the ceiling (`contextRatio`), the tip suggests
  compacting while the cache is warm, and shows what the same compaction costs after the cache
  expires. The ceiling is 250K tokens by default. For a model that charges more above a prompt
  size, such as Claude Haiku 5.5 above 100K tokens, the default ceiling is that size instead.
- **Large tool output.** A tool result stays in every later request in the session. The tip
  suggests asking for a narrower result next time.
- **Warming didn't keep the cache.** When warming is on and a request within the warming window
  still writes the context again, the tip says what that cost, and suggests turning warming off for
  the model, because its keep-alive requests cost money too. A provider can also drop a cache early,
  so one miss isn't proof that warming never works.

Tips stay in the TUI and never enter the conversation, so they don't add tokens or change the
cache. Subagent sessions don't get tips.

## Options

The options belong to the CLI part, which reads them from `cli.json`. Add the same package there
with the object form. OpenCode still loads the plugin once:

```json
{
  "plugins": [
    {
      "package": "opencode-cache-coach",
      "options": { "compactionModel": "gitlab/duo-chat-gpt-6-1-sol", "contextCeiling": 180000 }
    }
  ]
}
```

| Option            | Default                                  | Description                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tips`            | `true`                                   | Set to `false` to keep only the indicator.                                                                                                                                                                                |
| `notices`         | `true`                                   | Set to `false` to turn off the expiry messages.                                                                                                                                                                           |
| `compactionModel` |                                          | Model to suggest for compacting after the cache expires, such as `"gitlab/duo-chat-gpt-6-1-sol"`, or a list in order of preference. The plugin suggests the first one that fits the context and saves at least `minCost`. |
| `ttl`             |                                          | Cache lifetime, such as `"1h"`. Overrides the model and provider `cache.ttl`.                                                                                                                                             |
| `contextCeiling`  | `250000`, or where a higher price starts | Context size the ceiling tip measures against. Setting it applies to every model, including tiered ones. Capped at the model's input limit.                                                                               |
| `contextRatio`    | `0.8`                                    | Share of the ceiling at which the ceiling tip appears.                                                                                                                                                                    |
| `minTokens`       | `50000`                                  | Smallest context that a model-switch tip or an expiry message covers.                                                                                                                                                     |
| `minCost`         | `0.1`                                    | Smallest cost or cost difference, in USD, that a model-switch tip or an expiry message covers.                                                                                                                            |
| `largeOutput`     | `20000`                                  | Estimated tokens in a tool result at which the large-output tip appears.                                                                                                                                                  |

Costs come from the model prices OpenCode knows, including cache and long-context prices. Without
them, the indicator and tips leave the amounts out.

## Install a local build

Run `mise run build cache-coach` from the repository root, then point the plugin entries in your
`opencode.json` and `cli.json` at the package directory, such as
`"package": "/path/to/opencode-plugins/packages/cache-coach"`, and restart OpenCode.
