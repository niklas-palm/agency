/**
 * CloudWatch retention for every log group this platform owns.
 *
 * AWS expires nothing by default, so an unmanaged group keeps request logs, agent
 * output and stack traces FOREVER, at a bill that only grows - the one store in the
 * platform whose retention nobody had chosen. 30 days matches the trajectory
 * table's TTL: long enough to debug last month's incident, and the same horizon the
 * tenant data these logs talk about already has.
 *
 * Every one of those groups is created by AWS, not by CDK - Lambda makes
 * `/aws/lambda/<function>` on first invoke and AgentCore makes
 * `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` - so retention is applied to
 * the EXISTING group by name (`logs.LogRetention` = a PutRetentionPolicy custom
 * resource). Declaring our own `logs.LogGroup` and pointing each function at it is
 * the non-deprecated CDK path but the wrong one here: it renames every group and
 * leaves the ones already in the account orphaned, still holding a never-expiring
 * history, and it can't touch the AgentCore groups at all.
 */
import * as logs from "aws-cdk-lib/aws-logs";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/** How long CloudWatch keeps our logs. Change this one line to change the horizon. */
const RETENTION = logs.RetentionDays.ONE_MONTH;

/**
 * Expire a service-created log group named at deploy time. The group is created if
 * the service hasn't made it yet, and kept (not deleted) if this stack goes away.
 */
export function expireLogGroup(scope: Construct, id: string, logGroupName: string): void {
  new logs.LogRetention(scope, id, { logGroupName, retention: RETENTION });
}

/** Expire the log group Lambda creates for `fn` on its first invoke. */
export function expireFunctionLogs(fn: IFunction): void {
  expireLogGroup(fn, "LogRetention", `/aws/lambda/${fn.functionName}`);
}
