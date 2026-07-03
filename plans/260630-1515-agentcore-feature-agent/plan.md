# AgentCore feature agent

NestJS agent chạy trên AgentCore (region ap-southeast-1). Một agent loop (Strands)
gọi Bedrock, mỗi tính năng AgentCore là một module riêng. Không còn mock/legacy.

## Status: in progress

## Tính năng → service → API
| Tính năng | Module | AgentCore API |
|---|---|---|
| Long-term memory | `memory/` | CreateEvent, RetrieveMemoryRecords |
| Tạo/list phiên chat | `session/` | ListSessions (data plane) + actor/session ids |
| OAuth (Identity) | `identity/` | GetWorkloadAccessToken, GetResourceOauth2Token (M2M) |
| MCP tools | `mcp/` | Strands McpClient → Gateway URL, bearer từ Identity |
| Sandbox chạy code | `sandbox/` | StartCodeInterpreterSession, InvokeCodeInterpreter, Stop |

## Agent loop (1 turn)
load facts (memory) → build tools (sandbox + mcp) → Strands Agent.invoke → save turn (memory)

## Provisioning (scripts, chạy 1 lần với cred người dùng, theo thứ tự)
- `setup:iam`      → CreateRole x2 (memory exec + gateway) + inline policy
- `setup:cognito`  → UserPool + Domain + ResourceServer (scope agent/invoke) + M2M app client
- `setup:memory`   → CreateMemory (+ strategies namespaces `/facts/{actorId}`)
- `setup:identity` → CreateWorkloadIdentity + CreateOauth2CredentialProvider (M2M)
- `setup:gateway`  → CreateGateway (MCP, CUSTOM_JWT) + CreateGatewayTarget (OpenAPI public, no-auth)

## Inputs người dùng cấp (env)
- AWS creds + AGENT_MODEL_ID (ap-southeast-1 nên dùng inference profile `apac.*`)
- Còn lại (role ARNs, OAUTH_*) do setup:iam + setup:cognito tự sinh, dán vào .env.

## Removed legacy
mock-model.ts, ToolsService (calculator/get_time), types.ts, test.ts, AGENT_BACKEND/IS_AWS flag.

## Acceptance
- `npm run build` xanh.
- App boot: thiếu config feature nào thì log "disabled: set <ENV>", không crash, không mock.
- Mỗi feature gọi đúng API đã verify theo AWS API Reference.

## Notes / unresolved
- Code Interpreter default id `aws.codeinterpreter.v1` — đổi qua env nếu region khác.
- Gateway target dùng public OpenAPI (open-meteo) để khỏi cần Lambda; đổi target tùy nhu cầu.
- Không tự tạo IAM role / IdP (ngoài phạm vi "Gateway + Identity provider").
