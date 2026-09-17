# Z.AI endpoint facts (verified 2026-07-28)

DO NOT tell the user to "top up the Z.AI balance" on the strength of code 1113
alone. That conclusion was wrong once already.

Z.AI serves two hosts, and a key is valid on exactly one:

| Host | Plan |
|------|------|
| https://api.z.ai/api/paas/v4        | pay-as-you-go / prepaid balance |
| https://api.z.ai/api/coding/paas/v4 | Coding Plan subscription        |

A Coding Plan key AUTHENTICATES on the pay-as-you-go host - `GET /models`
returns HTTP 200 - but every completion there fails with HTTP 429, business code
1113, "Insufficient balance or no resource package". That looks identical to a
drained key.

Measured across six keys on 2026-07-28: all six returned 1113 on `/paas/v4`;
five of six returned HTTP 200 on `/coding/paas/v4`. Only one key was genuinely
exhausted. glm-5.2, glm-5.1, glm-5, glm-4.7 and glm-4.6 all answer 200 on the
Coding Plan host.

Before concluding a Z.AI key is dead, test BOTH hosts:

    curl -s -o /dev/null -w '%{http_code}\n' \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
      https://api.z.ai/api/coding/paas/v4/chat/completions

`ModelProvider.zai` defaults to the Coding Plan host. The Models tab exposes both
as presets. The agent server's EXTERNAL_URLS.ZAI_API already used the coding
host, but the Swift client passes its own baseUrl and `createZaiFactory` uses
`config.baseUrl || EXTERNAL_URLS.ZAI_API`, so the client value wins.
