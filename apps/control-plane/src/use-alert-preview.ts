import { useEffect, useState } from "react";
import { alertRequest, previewAlert, type AlertForm } from "./alerts-api";

// Name, delivery and enabled state do not change the data being previewed.
export function useAlertPreview(form: AlertForm | null, hours: number, revision = 0) {
  const rangeOptions = [1, 6, 24].filter((value) => value * 60 >= (form?.windowMinutes ?? 1));
  const selectedHours = rangeOptions.find((value) => value >= hours) ?? 24;
  const request = form
    ? alertRequest({
        ...form,
        name: "Preview",
        enabled: true,
        slack: "",
        threshold: form.threshold.trim() && Number.isFinite(Number(form.threshold)) ? form.threshold : "0",
      })
    : null;
  const key = request && "body" in request ? JSON.stringify({ body: request.body, hours: selectedHours, revision }) : null;
  const [result, setResult] = useState<{
    key: string;
    data?: Awaited<ReturnType<typeof previewAlert>>;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { body, hours } = JSON.parse(key) as { body: Parameters<typeof previewAlert>[0]; hours: number };
      void previewAlert(body, hours).then(
        (data) => {
          if (!cancelled) setResult({ key, data });
        },
        (error: unknown) => {
          if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : "Unable to load chart" });
        },
      );
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);
  const current = result?.key === key ? result : null;
  return {
    rangeOptions,
    selectedHours,
    data: current?.data,
    error: request && "error" in request ? request.error : current?.error,
    loading: !!key && !current,
  };
}
