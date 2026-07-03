import {
	BedrockAgentCoreClient,
	InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore"
import process from "process"
import dotenv from "dotenv"
import { randomUUID } from "crypto"

dotenv.config()

const client = new BedrockAgentCoreClient({ region: "ap-southeast-1" })
const runtimeSessionId = `session-${randomUUID()}`

const command = new InvokeHarnessCommand({
	harnessArn:
		"arn:aws:bedrock-agentcore:ap-southeast-1:536697262305:harness/harness_27dkj-dj8yqIEwK4",
	runtimeSessionId: runtimeSessionId,
	messages: [
		{
			role: "user",
			content: [{ text: "Hello, how can you help me?" }],
		},
	],
})

async function main() {
	const response = await client.send(command)
	// Process the streaming response
	if (response.stream) {
		for await (const event of response.stream) {
			if (event.contentBlockDelta?.delta?.text) {
				process.stdout.write(event.contentBlockDelta.delta.text)
			}
		}
	}
}
main()
