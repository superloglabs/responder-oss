// A CloudWatch metric stream in the OpenTelemetry format names each metric
// "amazonaws.com/<namespace>/<metric>", such as
// "amazonaws.com/AWS/EC2/CPUUtilization", and sends no description. These
// tables give the namespaces the AWS telemetry stack streams, and their common
// metrics, a readable name and description. Other metrics are named from
// their CloudWatch name.

type MetricText = readonly [title: string, description: string];

interface CloudWatchService {
  metrics: Record<string, MetricText>;
  // The service as it reads before a metric title, such as "EC2".
  name: string;
}

const prefix = "amazonaws.com/";

const loadBalancerTargets: Record<string, MetricText> = {
  ActiveConnectionCount: ["Active connections", "Concurrent TCP connections from clients to the load balancer and from the load balancer to targets."],
  ClientTLSNegotiationErrorCount: ["Client TLS errors", "TLS handshakes started by clients that failed."],
  ConsumedLCUs: ["Load balancer capacity units", "Load balancer capacity units (LCUs) used, which set the hourly price."],
  HealthyHostCount: ["Healthy targets", "Targets passing health checks."],
  NewConnectionCount: ["New connections", "TCP connections opened from clients to the load balancer and from the load balancer to targets."],
  ProcessedBytes: ["Bytes processed", "Bytes the load balancer processed over IPv4 and IPv6."],
  RejectedConnectionCount: ["Rejected connections", "Connections rejected because the load balancer reached its connection limit."],
  RequestCount: ["Requests", "Requests the load balancer processed."],
  RequestCountPerTarget: ["Requests per target", "Requests divided by the healthy targets in the target group."],
  TargetConnectionErrorCount: ["Target connection errors", "Connections from the load balancer to a target that failed to open."],
  TargetResponseTime: ["Target response time", "Seconds from a request leaving the load balancer until the target starts its response."],
  TargetTLSNegotiationErrorCount: ["Target TLS errors", "TLS handshakes from the load balancer to targets that failed."],
  UnHealthyHostCount: ["Unhealthy targets", "Targets failing health checks."],
};

const services: Record<string, CloudWatchService> = {
  "AWS/ApiGateway": {
    metrics: {
      "4XXError": ["4XX errors", "Requests that ended in a client error."],
      "4xx": ["4XX errors", "Requests that ended in a client error."],
      "5XXError": ["5XX errors", "Requests that ended in a server error."],
      "5xx": ["5XX errors", "Requests that ended in a server error."],
      CacheHitCount: ["Cache hits", "Requests served from the API cache."],
      CacheMissCount: ["Cache misses", "Requests the API cache could not serve, sent to the backend."],
      Count: ["Requests", "API requests received."],
      DataProcessed: ["Data processed", "Bytes the API processed."],
      IntegrationLatency: ["Integration latency", "Milliseconds the backend took to respond to API Gateway."],
      Latency: ["Latency", "Milliseconds from API Gateway receiving a request to sending its response."],
    },
    name: "API Gateway",
  },
  "AWS/ApplicationELB": {
    metrics: {
      ...loadBalancerTargets,
      HTTP_Fixed_Response_Count: ["Fixed responses", "Fixed-response actions that succeeded."],
      HTTP_Redirect_Count: ["Redirects", "Redirect actions that succeeded."],
      RuleEvaluations: ["Rule evaluations", "Listener rules evaluated, averaged over an hour."],
    },
    name: "Application Load Balancer",
  },
  "AWS/CloudFront": {
    metrics: {
      "401ErrorRate": ["401 error rate", "Percent of requests answered with 401 Unauthorized."],
      "403ErrorRate": ["403 error rate", "Percent of requests answered with 403 Forbidden."],
      "404ErrorRate": ["404 error rate", "Percent of requests answered with 404 Not Found."],
      "4xxErrorRate": ["4XX error rate", "Percent of requests answered with a 4XX status."],
      "502ErrorRate": ["502 error rate", "Percent of requests answered with 502 Bad Gateway."],
      "503ErrorRate": ["503 error rate", "Percent of requests answered with 503 Service Unavailable."],
      "504ErrorRate": ["504 error rate", "Percent of requests answered with 504 Gateway Timeout."],
      "5xxErrorRate": ["5XX error rate", "Percent of requests answered with a 5XX status."],
      BytesDownloaded: ["Bytes downloaded", "Bytes viewers downloaded for GET, HEAD and OPTIONS requests."],
      BytesUploaded: ["Bytes uploaded", "Bytes viewers uploaded to the origin with POST and PUT requests."],
      CacheHitRate: ["Cache hit rate", "Percent of cacheable requests served from the CloudFront cache."],
      FunctionExecutionErrors: ["Function errors", "CloudFront Functions invocations that failed."],
      FunctionInvocations: ["Function invocations", "CloudFront Functions invocations."],
      FunctionThrottles: ["Function throttles", "CloudFront Functions invocations that were throttled."],
      OriginLatency: ["Origin latency", "Milliseconds from CloudFront sending a request to the origin until the first byte of its response."],
      Requests: ["Requests", "Viewer requests for all HTTP methods."],
      TotalErrorRate: ["Error rate", "Percent of requests answered with a 4XX or 5XX status."],
    },
    name: "CloudFront",
  },
  "AWS/DynamoDB": {
    metrics: {
      ConditionalCheckFailedRequests: ["Failed condition checks", "Writes rejected because their condition evaluated to false."],
      ConsumedReadCapacityUnits: ["Read capacity used", "Read capacity units consumed."],
      ConsumedWriteCapacityUnits: ["Write capacity used", "Write capacity units consumed."],
      ProvisionedReadCapacityUnits: ["Provisioned read capacity", "Read capacity units provisioned for the table or index."],
      ProvisionedWriteCapacityUnits: ["Provisioned write capacity", "Write capacity units provisioned for the table or index."],
      ReadThrottleEvents: ["Throttled reads", "Read requests throttled for exceeding capacity."],
      ReplicationLatency: ["Replication latency", "Milliseconds for an update to reach another global table replica."],
      ReturnedBytes: ["Bytes returned", "Bytes returned by GetRecords on the table's stream."],
      ReturnedItemCount: ["Items returned", "Items returned by queries, scans and ExecuteStatement selects."],
      SuccessfulRequestLatency: ["Request latency", "Milliseconds DynamoDB took to serve successful requests."],
      SystemErrors: ["System errors", "Requests that failed with an HTTP 500 from DynamoDB."],
      ThrottledRequests: ["Throttled requests", "Requests that exceeded provisioned throughput."],
      TimeToLiveDeletedItemCount: ["Items expired by TTL", "Items deleted by time to live."],
      TransactionConflict: ["Transaction conflicts", "Item requests rejected because of a conflicting transaction."],
      UserErrors: ["User errors", "Requests that failed with an HTTP 400 caused by the client."],
      WriteThrottleEvents: ["Throttled writes", "Write requests throttled for exceeding capacity."],
    },
    name: "DynamoDB",
  },
  "AWS/EBS": {
    metrics: {
      BurstBalance: ["Burst balance", "Percent of the volume's I/O burst credits remaining."],
      VolumeConsumedReadWriteOps: ["Consumed IOPS", "Read and write operations consumed, for Provisioned IOPS volumes."],
      VolumeIdleTime: ["Idle time", "Seconds with no read or write operations."],
      VolumeQueueLength: ["Queue length", "Read and write operations waiting to complete."],
      VolumeReadBytes: ["Bytes read", "Bytes read from the volume."],
      VolumeReadOps: ["Read operations", "Read operations on the volume."],
      VolumeStalledIOCheck: ["Stalled I/O check", "1 when the volume failed to complete I/O, otherwise 0."],
      VolumeThroughputPercentage: ["Throughput percentage", "Percent of provisioned IOPS delivered, for Provisioned IOPS volumes."],
      VolumeTotalReadTime: ["Total read time", "Seconds spent on all read operations."],
      VolumeTotalWriteTime: ["Total write time", "Seconds spent on all write operations."],
      VolumeWriteBytes: ["Bytes written", "Bytes written to the volume."],
      VolumeWriteOps: ["Write operations", "Write operations on the volume."],
    },
    name: "EBS",
  },
  "AWS/EC2": {
    metrics: {
      CPUCreditBalance: ["CPU credit balance", "CPU credits a burstable instance has earned and not spent."],
      CPUCreditUsage: ["CPU credits used", "CPU credits a burstable instance spent."],
      CPUSurplusCreditBalance: ["CPU surplus credit balance", "Surplus credits an unlimited burstable instance spent with no earned credits left."],
      CPUSurplusCreditsCharged: ["CPU surplus credits charged", "Surplus credits that incur an extra charge."],
      CPUUtilization: ["CPU utilization", "Percent of the instance's allocated CPU in use."],
      DiskReadBytes: ["Disk bytes read", "Bytes read from instance store volumes."],
      DiskReadOps: ["Disk read operations", "Read operations on instance store volumes."],
      DiskWriteBytes: ["Disk bytes written", "Bytes written to instance store volumes."],
      DiskWriteOps: ["Disk write operations", "Write operations on instance store volumes."],
      "EBSByteBalance%": ["EBS byte balance", "Percent of the instance's EBS throughput burst credits remaining."],
      "EBSIOBalance%": ["EBS I/O balance", "Percent of the instance's EBS I/O burst credits remaining."],
      EBSReadBytes: ["EBS bytes read", "Bytes read from attached EBS volumes."],
      EBSReadOps: ["EBS read operations", "Read operations on attached EBS volumes."],
      EBSWriteBytes: ["EBS bytes written", "Bytes written to attached EBS volumes."],
      EBSWriteOps: ["EBS write operations", "Write operations on attached EBS volumes."],
      MetadataNoToken: ["Metadata calls without a token", "Instance metadata requests made with IMDSv1, without a session token."],
      NetworkIn: ["Network bytes in", "Bytes received on all network interfaces."],
      NetworkOut: ["Network bytes out", "Bytes sent on all network interfaces."],
      NetworkPacketsIn: ["Network packets in", "Packets received on all network interfaces."],
      NetworkPacketsOut: ["Network packets out", "Packets sent on all network interfaces."],
      StatusCheckFailed: ["Status check failed", "1 when the instance or system status check failed, otherwise 0."],
      StatusCheckFailed_AttachedEBS: ["EBS status check failed", "1 when an attached EBS volume failed its status check, otherwise 0."],
      StatusCheckFailed_Instance: ["Instance status check failed", "1 when the instance status check failed, otherwise 0."],
      StatusCheckFailed_System: ["System status check failed", "1 when the AWS system status check failed, otherwise 0."],
    },
    name: "EC2",
  },
  "AWS/ECS": {
    // ECS also reports Service Connect traffic, named as on a load balancer.
    metrics: {
      ...loadBalancerTargets,
      CPUReservation: ["CPU reserved", "Percent of the cluster's CPU reserved by running tasks."],
      CPUUtilization: ["CPU utilization", "Percent of reserved CPU in use."],
      GPUReservation: ["GPU reserved", "Percent of the cluster's GPUs reserved by running tasks."],
      MemoryReservation: ["Memory reserved", "Percent of the cluster's memory reserved by running tasks."],
      MemoryUtilization: ["Memory utilization", "Percent of reserved memory in use."],
    },
    name: "ECS",
  },
  "AWS/ELB": {
    metrics: {
      BackendConnectionErrors: ["Backend connection errors", "Connections from the load balancer to instances that failed."],
      HealthyHostCount: ["Healthy instances", "Registered instances passing health checks."],
      Latency: ["Latency", "Seconds from the request leaving the load balancer until the instance starts its response."],
      RequestCount: ["Requests", "Requests the load balancer processed."],
      SpilloverCount: ["Spillover", "Requests rejected because the surge queue was full."],
      SurgeQueueLength: ["Surge queue length", "Requests waiting for a healthy instance."],
      UnHealthyHostCount: ["Unhealthy instances", "Registered instances failing health checks."],
    },
    name: "Classic Load Balancer",
  },
  "AWS/ElastiCache": {
    metrics: {
      BytesUsedForCache: ["Memory used for cache", "Bytes of memory used for cached data."],
      CPUUtilization: ["CPU utilization", "Percent of the host's CPU in use."],
      CacheHitRate: ["Cache hit rate", "Percent of key lookups that found the key."],
      CacheHits: ["Cache hits", "Key lookups that found the key."],
      CacheMisses: ["Cache misses", "Key lookups that did not find the key."],
      CurrConnections: ["Connections", "Client connections open, excluding replica connections."],
      CurrItems: ["Items", "Items stored in the cache."],
      DatabaseMemoryUsagePercentage: ["Memory usage", "Percent of the node's memory in use."],
      EngineCPUUtilization: ["Engine CPU utilization", "Percent of CPU in use by the Redis or Valkey engine thread."],
      Evictions: ["Evictions", "Keys evicted because of the memory limit."],
      FreeableMemory: ["Freeable memory", "Bytes of memory available on the host."],
      MemoryFragmentationRatio: ["Memory fragmentation", "Memory the operating system gave the engine divided by the memory the engine uses."],
      NetworkBytesIn: ["Network bytes in", "Bytes the host received."],
      NetworkBytesOut: ["Network bytes out", "Bytes the host sent."],
      NewConnections: ["New connections", "Connections the cache accepted."],
      ReplicationLag: ["Replication lag", "Seconds a replica is behind the primary."],
      SwapUsage: ["Swap used", "Bytes of swap in use on the host."],
    },
    name: "ElastiCache",
  },
  "AWS/Lambda": {
    metrics: {
      AsyncEventAge: ["Async event age", "Milliseconds an asynchronous event waited before invocation."],
      AsyncEventsDropped: ["Async events dropped", "Asynchronous events dropped without running the function."],
      AsyncEventsReceived: ["Async events received", "Asynchronous events Lambda queued for the function."],
      ConcurrentExecutions: ["Concurrent executions", "Function instances processing events."],
      DeadLetterErrors: ["Dead-letter errors", "Failed asynchronous events Lambda could not send to the dead-letter queue."],
      DestinationDeliveryFailures: ["Destination delivery failures", "Events Lambda could not send to the configured destination."],
      Duration: ["Duration", "Milliseconds the function code spent processing an event."],
      Errors: ["Errors", "Invocations that ended in a function error."],
      Invocations: ["Invocations", "Times the function code ran, including errors."],
      IteratorAge: ["Iterator age", "Milliseconds between a stream record arriving and the function processing it."],
      ProvisionedConcurrencyUtilization: ["Provisioned concurrency utilization", "Share of provisioned concurrency in use."],
      ProvisionedConcurrentExecutions: ["Provisioned concurrent executions", "Instances processing events on provisioned concurrency."],
      Throttles: ["Throttles", "Invocation requests throttled for exceeding concurrency."],
      UnreservedConcurrentExecutions: ["Unreserved concurrent executions", "Concurrent executions of functions without reserved concurrency."],
    },
    name: "Lambda",
  },
  "AWS/NetworkELB": {
    metrics: {
      ActiveFlowCount: ["Active flows", "Concurrent flows from clients to targets."],
      ClientTLSNegotiationErrorCount: ["Client TLS errors", "TLS handshakes from clients that failed."],
      ConsumedLCUs: ["Load balancer capacity units", "Load balancer capacity units (LCUs) used, which set the hourly price."],
      HealthyHostCount: ["Healthy targets", "Targets passing health checks."],
      NewFlowCount: ["New flows", "Flows opened from clients to targets."],
      PortAllocationErrorCount: ["Port allocation errors", "Ephemeral port allocation failures during client IP translation."],
      ProcessedBytes: ["Bytes processed", "Bytes the load balancer processed."],
      ProcessedPackets: ["Packets processed", "Packets the load balancer processed."],
      TCP_Client_Reset_Count: ["Client TCP resets", "Reset packets sent from clients to targets."],
      TCP_ELB_Reset_Count: ["Load balancer TCP resets", "Reset packets generated by the load balancer."],
      TCP_Target_Reset_Count: ["Target TCP resets", "Reset packets sent from targets to clients."],
      TargetTLSNegotiationErrorCount: ["Target TLS errors", "TLS handshakes from the load balancer to targets that failed."],
      UnHealthyHostCount: ["Unhealthy targets", "Targets failing health checks."],
    },
    name: "Network Load Balancer",
  },
  "AWS/RDS": {
    metrics: {
      BinLogDiskUsage: ["Binary log disk used", "Bytes of disk used by binary logs on the source."],
      BurstBalance: ["Burst balance", "Percent of the storage's I/O burst credits remaining."],
      CPUCreditBalance: ["CPU credit balance", "CPU credits a burstable instance has earned and not spent."],
      CPUCreditUsage: ["CPU credits used", "CPU credits a burstable instance spent."],
      CPUUtilization: ["CPU utilization", "Percent of the database instance's CPU in use."],
      CheckpointLag: ["Checkpoint lag", "Seconds since the most recent checkpoint."],
      DBLoad: ["Database load", "Average active sessions on the database engine."],
      DBLoadCPU: ["Database load on CPU", "Average active sessions waiting on CPU."],
      DBLoadNonCPU: ["Database load not on CPU", "Average active sessions waiting on something other than CPU."],
      DatabaseConnections: ["Connections", "Client connections to the database instance."],
      DiskQueueDepth: ["Disk queue depth", "Disk I/O requests waiting to be served."],
      "EBSByteBalance%": ["EBS byte balance", "Percent of the instance's EBS throughput burst credits remaining."],
      "EBSIOBalance%": ["EBS I/O balance", "Percent of the instance's EBS I/O burst credits remaining."],
      FreeLocalStorage: ["Free local storage", "Bytes of local storage available."],
      FreeStorageSpace: ["Free storage", "Bytes of storage available."],
      FreeableMemory: ["Freeable memory", "Bytes of memory available."],
      MaximumUsedTransactionIDs: ["Maximum used transaction IDs", "Highest transaction ID age used, which approaches wraparound."],
      NetworkReceiveThroughput: ["Network bytes in", "Bytes per second the instance received."],
      NetworkTransmitThroughput: ["Network bytes out", "Bytes per second the instance sent."],
      OldestReplicationSlotLag: ["Oldest replication slot lag", "Bytes of write-ahead log the most lagging replication slot has not consumed."],
      ReadIOPS: ["Read IOPS", "Disk read operations per second."],
      ReadLatency: ["Read latency", "Seconds per disk read operation."],
      ReadThroughput: ["Read throughput", "Bytes per second read from disk."],
      ReplicaLag: ["Replica lag", "Seconds a read replica is behind its source."],
      SwapUsage: ["Swap used", "Bytes of swap in use."],
      TransactionLogsDiskUsage: ["Transaction log disk used", "Bytes of disk used by transaction logs."],
      TransactionLogsGeneration: ["Transaction log generation", "Bytes per second of transaction logs written."],
      WriteIOPS: ["Write IOPS", "Disk write operations per second."],
      WriteLatency: ["Write latency", "Seconds per disk write operation."],
      WriteThroughput: ["Write throughput", "Bytes per second written to disk."],
    },
    name: "RDS",
  },
  "AWS/S3": {
    metrics: {
      "4xxErrors": ["4XX errors", "Requests answered with a 4XX status."],
      "5xxErrors": ["5XX errors", "Requests answered with a 5XX status."],
      AllRequests: ["Requests", "HTTP requests of any type made to the bucket."],
      BucketSizeBytes: ["Bucket size", "Bytes stored in the bucket, reported daily."],
      BytesDownloaded: ["Bytes downloaded", "Bytes downloaded from the bucket."],
      BytesUploaded: ["Bytes uploaded", "Bytes uploaded to the bucket."],
      DeleteRequests: ["DELETE requests", "DELETE requests made to the bucket."],
      FirstByteLatency: ["First byte latency", "Milliseconds from receiving a request until the first byte of the response."],
      GetRequests: ["GET requests", "GET requests made to the bucket."],
      HeadRequests: ["HEAD requests", "HEAD requests made to the bucket."],
      ListRequests: ["LIST requests", "Requests that list the bucket's contents."],
      NumberOfObjects: ["Objects", "Objects stored in the bucket, reported daily."],
      PostRequests: ["POST requests", "POST requests made to the bucket."],
      PutRequests: ["PUT requests", "PUT requests made to the bucket."],
      TotalRequestLatency: ["Request latency", "Milliseconds from the first byte received to the last byte sent."],
    },
    name: "S3",
  },
  "AWS/SNS": {
    metrics: {
      NumberOfMessagesPublished: ["Messages published", "Messages published to the topic."],
      NumberOfNotificationsDelivered: ["Notifications delivered", "Messages delivered to subscribers."],
      NumberOfNotificationsFailed: ["Notifications failed", "Messages SNS failed to deliver."],
      NumberOfNotificationsFilteredOut: ["Notifications filtered out", "Messages a subscription's filter policy rejected."],
      PublishSize: ["Publish size", "Bytes per published message."],
    },
    name: "SNS",
  },
  "AWS/SQS": {
    metrics: {
      ApproximateAgeOfOldestMessage: ["Oldest message age", "Seconds the oldest message has waited in the queue."],
      ApproximateNumberOfMessagesDelayed: ["Delayed messages", "Messages delayed and not yet available to read."],
      ApproximateNumberOfMessagesNotVisible: ["Messages in flight", "Messages received by a consumer and not yet deleted."],
      ApproximateNumberOfMessagesVisible: ["Messages waiting", "Messages available to read from the queue."],
      NumberOfEmptyReceives: ["Empty receives", "Receive calls that returned no message."],
      NumberOfMessagesDeleted: ["Messages deleted", "Messages deleted from the queue."],
      NumberOfMessagesReceived: ["Messages received", "Messages returned by receive calls."],
      NumberOfMessagesSent: ["Messages sent", "Messages added to the queue."],
      SentMessageSize: ["Message size", "Bytes per message added to the queue."],
    },
    name: "SQS",
  },
  "ECS/ContainerInsights": {
    metrics: {
      ContainerInstanceCount: ["Container instances", "EC2 instances registered with the cluster."],
      CpuReserved: ["CPU reserved", "CPU units reserved by tasks."],
      CpuUtilized: ["CPU used", "CPU units used by tasks."],
      DeploymentCount: ["Deployments", "Deployments in the service."],
      DesiredTaskCount: ["Desired tasks", "Tasks the service is set to run."],
      EphemeralStorageReserved: ["Ephemeral storage reserved", "Bytes of ephemeral storage reserved by Fargate tasks."],
      EphemeralStorageUtilized: ["Ephemeral storage used", "Bytes of ephemeral storage used by Fargate tasks."],
      MemoryReserved: ["Memory reserved", "Memory reserved by tasks."],
      MemoryUtilized: ["Memory used", "Memory used by tasks."],
      NetworkRxBytes: ["Network bytes in", "Bytes per second received by tasks."],
      NetworkTxBytes: ["Network bytes out", "Bytes per second sent by tasks."],
      PendingTaskCount: ["Pending tasks", "Tasks waiting to start."],
      RestartCount: ["Container restarts", "Times containers in tasks restarted."],
      RunningTaskCount: ["Running tasks", "Tasks running."],
      ServiceCount: ["Services", "Services in the cluster."],
      StorageReadBytes: ["Storage bytes read", "Bytes read from storage by tasks."],
      StorageWriteBytes: ["Storage bytes written", "Bytes written to storage by tasks."],
      TaskCount: ["Tasks", "Tasks running in the cluster."],
      TaskSetCount: ["Task sets", "Task sets in the service."],
    },
    name: "ECS Container Insights",
  },
};

const statusSources: Record<string, string> = { Backend: "Backend", ELB: "Load balancer", Target: "Target" };

// Status-code counts such as "HTTPCode_Target_5XX_Count" and
// "HTTPCode_ELB_502_Count", and NLB protocol variants such as
// "ActiveFlowCount_TLS".
function patternText(service: CloudWatchService, metric: string): MetricText | null {
  const status = /^HTTPCode_(Backend|ELB|Target)_(\w+?)_Count$/u.exec(metric);
  if (status) {
    const source = statusSources[status[1]!]!;
    return [
      `${source} ${status[2]} responses`,
      status[1] === "ELB"
        ? `Responses with a ${status[2]} status generated by the load balancer.`
        : `Responses with a ${status[2]} status returned by ${source.toLocaleLowerCase()}s.`,
    ];
  }
  const protocol = /^(.+)_(TCP|TLS|UDP)$/u.exec(metric);
  const base = protocol ? service.metrics[protocol[1]!] : undefined;
  if (protocol && base) return [`${base[0]} (${protocol[2]})`, `${base[1].slice(0, -1)}, over ${protocol[2]}.`];
  return null;
}

const acronyms = new Set(["api", "cpu", "dlq", "ebs", "gpu", "http", "io", "iops", "ip", "lcu", "lcus", "tcp", "tls", "ttl", "udp"]);

// "CpuUtilized" reads "CPU utilized", "TCP_Target_Reset_Count" reads
// "TCP target reset count".
export function humanizeCloudWatchName(name: string): string {
  const words = name
    .replace(/[_%]+/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  return words
    .map((word, index) => {
      if (acronyms.has(word.toLocaleLowerCase())) return word.toLocaleUpperCase();
      if (word.length > 1 && word === word.toLocaleUpperCase()) return word;
      return index === 0 ? word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase() : word.toLocaleLowerCase();
    })
    .join(" ");
}

export interface CloudWatchMetricName {
  description: string;
  // The service's group, such as "AWS EC2".
  group: string;
  metric: string;
  namespace: string;
  // The service before the title, such as "EC2 CPU utilization", for places
  // that show the metric outside its group.
  standalone: string;
  title: string;
}

// The parts of a CloudWatch metric stream name, or null for other metrics.
export function cloudWatchMetricName(name: string): CloudWatchMetricName | null {
  if (!name.startsWith(prefix)) return null;
  const path = name.slice(prefix.length);
  const slash = path.lastIndexOf("/");
  if (slash <= 0 || slash === path.length - 1) return null;
  const namespace = path.slice(0, slash);
  const metric = path.slice(slash + 1);
  const service = services[namespace];
  const serviceName = service?.name ?? namespace.replace(/^AWS\//u, "").replaceAll("/", " ");
  const text = service ? (service.metrics[metric] ?? patternText(service, metric)) : null;
  const title = text?.[0] ?? humanizeCloudWatchName(metric);
  // Lowercase a title's first word unless it is an acronym, such as "CPU".
  const titleInSentence = /^[A-Z][a-z]/u.test(title) ? title[0]!.toLocaleLowerCase() + title.slice(1) : title;
  return {
    description: text?.[1] ?? `CloudWatch metric ${metric} in ${namespace}.`,
    group: `AWS ${serviceName}`,
    metric,
    namespace,
    standalone: `${serviceName} ${titleInSentence}`,
    title,
  };
}
