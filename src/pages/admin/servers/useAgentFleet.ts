import { useCallback, useEffect, useState } from "react";
import { getRPC2Client } from "@/contexts/RPC2Context";

/** 同一 token 被多个 Agent 进程抢连接时，主控给出的冲突信息 */
export type AgentConflict = {
  takeovers: number;
  last_at: string;
  last_ip: string;
};

/** 支持主控下发“切换版本”的最低 Agent 版本 */
export const MIN_REMOTE_UPGRADE_VERSION = "2.0.4";

const parseVersion = (version: string): number[] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((version || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** a < b 返回负数；任一方不是 x.y.z（如快照版）时返回 null */
export const compareVersions = (a: string, b: string): number | null => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
};

export const isOutdated = (version: string, hosted: string) =>
  (compareVersions(version, hosted) ?? 0) < 0;

export const supportsRemoteUpgrade = (version: string) =>
  (compareVersions(version, MIN_REMOTE_UPGRADE_VERSION) ?? -1) >= 0;

export type UpgradeResult = "queued" | "unsupported" | "failed";

/** 主控托管的 Agent 版本、节点连接冲突，以及下发升级 */
export default function useAgentFleet() {
  const [hostedVersion, setHostedVersion] = useState("");
  const [conflicts, setConflicts] = useState<Record<string, AgentConflict>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/download/agent/VERSION", { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (!cancelled && parseVersion(text)) setHostedVersion(text.trim());
      })
      .catch(() => {});

    const loadConflicts = () => {
      if (document.hidden) return;
      getRPC2Client()
        .call<unknown, Record<string, AgentConflict>>("admin:getAgentConflicts", {})
        .then((data) => {
          if (!cancelled) setConflicts(data ?? {});
        })
        .catch(() => {});
    };
    loadConflicts();
    const interval = setInterval(loadConflicts, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const upgrade = useCallback(
    async (uuid: string, currentVersion: string): Promise<UpgradeResult> => {
      if (!hostedVersion || !supportsRemoteUpgrade(currentVersion)) return "unsupported";
      try {
        await getRPC2Client().call("admin:switchAgentVersion", {
          uuid,
          version: hostedVersion,
        });
        return "queued";
      } catch {
        return "failed";
      }
    },
    [hostedVersion],
  );

  return { hostedVersion, conflicts, upgrade };
}

export type AgentFleet = ReturnType<typeof useAgentFleet>;
