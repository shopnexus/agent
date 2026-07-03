import "dotenv/config"
import { randomUUID } from "crypto"
import {
	BedrockAgentCoreClient,
	InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore"

const region = process.env.AWS_REGION ?? "ap-southeast-1"
const harnessArn = process.env.HARNESS_ARN

if (!harnessArn) {
	console.error("Missing HARNESS_ARN")
	process.exit(1)
}

const client = new BedrockAgentCoreClient({ region })

const LOCAL_TOOLS: Record<
	string,
	{
		description: string
		inputSchema: object
		run: (input: any) => string
	}
> = {
	add: {
		description: "Add two numbers.",
		inputSchema: {
			type: "object",
			properties: {
				a: { type: "number" },
				b: { type: "number" },
			},
			required: ["a", "b"],
			additionalProperties: false,
		},
		run: ({ a, b }) => String(Number(a) + Number(b)),
	},

	get_current_time: {
		description: "Return current ISO datetime.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		run: () => new Date().toISOString(),
	},
}

const harnessTools = Object.entries(LOCAL_TOOLS).map(([name, tool]) => ({
	type: "inline_function",
	name,
	config: {
		inlineFunction: {
			description: tool.description,
			inputSchema: tool.inputSchema,
		},
	},
}))

interface PendingToolUse {
	toolUseId: string
	name: string
	input: string
}

const messages: any[] = []

async function invokeOnce(sessionId: string): Promise<PendingToolUse[]> {
	const res = await client.send(
		new InvokeHarnessCommand({
			harnessArn,
			runtimeSessionId: sessionId,
			messages,
			tools: harnessTools,
		} as any),
	)

	const toolUses = new Map<number, PendingToolUse>()
	const assistantContent: any[] = []

	if (!res.stream) return []

	for await (const event of res.stream as AsyncIterable<any>) {
		const start = event.contentBlockStart

		if (start?.start?.toolUse) {
			const tool = start.start.toolUse

			toolUses.set(start.contentBlockIndex, {
				toolUseId: tool.toolUseId,
				name: tool.name,
				input: "",
			})
		}

		const delta = event.contentBlockDelta?.delta

		if (delta?.text) {
			process.stdout.write(delta.text)

			assistantContent.push({
				text: delta.text,
			})
		}

		if (delta?.toolUse?.input !== undefined) {
			const t = toolUses.get(event.contentBlockDelta.contentBlockIndex)

			if (t) t.input += delta.toolUse.input
		}

		if (event.metadata?.usage) {
			const u = event.metadata.usage

			process.stdout.write(
				`\n[usage in=${u.inputTokens} out=${u.outputTokens}]`,
			)
		}
	}

	//
	// IMPORTANT:
	// Preserve assistant toolUse message
	//
	for (const t of toolUses.values()) {
		assistantContent.push({
			toolUse: {
				toolUseId: t.toolUseId,
				name: t.name,
				input: t.input ? JSON.parse(t.input) : {},
			},
		})
	}

	if (assistantContent.length) {
		messages.push({
			role: "assistant",
			content: assistantContent,
		})
	}

	return [...toolUses.values()]
}

function executeTools(toolUses: PendingToolUse[]) {
	const content: any[] = []

	for (const t of toolUses) {
		let status: "success" | "error" = "success"
		let text = ""

		try {
			const tool = LOCAL_TOOLS[t.name]

			if (!tool) {
				throw new Error(`Unknown tool ${t.name}`)
			}

			const input = t.input ? JSON.parse(t.input) : {}

			text = tool.run(input)

			console.log(`\n🔧 ${t.name}(${JSON.stringify(input)}) -> ${text}`)
		} catch (err: any) {
			status = "error"
			text = err.message
		}

		content.push({
			toolResult: {
				toolUseId: t.toolUseId,
				status,
				content: [{ text }],
			},
		})
	}

	messages.push({
		role: "user",
		content,
	})
}

async function main() {
	const prompt =
		process.argv.slice(2).join(" ") || "What is 21 + 21? Also, what time is it?"

	const sessionId = `harness-${randomUUID()}`

	console.log(`\n=== Harness demo (${region}) ===`)
	console.log(`> ${prompt}\n`)

	messages.push({
		role: "user",
		content: [
			{
				text: prompt,
			},
		],
	})

	let toolUses = await invokeOnce(sessionId)

	while (toolUses.length) {
		executeTools(toolUses)
		toolUses = await invokeOnce(sessionId)
	}

	console.log("\n")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
