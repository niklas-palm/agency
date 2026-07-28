/**
 * Shared DynamoDB document client. Same code, different endpoint - local dev
 * points at DynamoDB Local; prod uses the default AWS credential chain.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DDB_ENDPOINT, REGION } from "./config.js";

const base = new DynamoDBClient({
  region: REGION,
  ...(DDB_ENDPOINT
    ? { endpoint: DDB_ENDPOINT, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
    : {}),
});

export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true },
});
