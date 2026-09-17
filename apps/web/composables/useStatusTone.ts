export function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch ((status || "").toLowerCase()) {
    case "active":
    case "completed":
    case "ready":
    case "approved":
      return "success";
    case "in_progress":
    case "processing":
    case "submitted":
    case "downloading":
      return "info";
    case "draft":
    case "pending":
    case "queued":
      return "warning";
    case "archived":
    case "failed":
    case "rejected":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}
