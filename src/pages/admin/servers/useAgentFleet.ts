import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { NodeDetail } from "@/contexts/NodeDetailsContext";
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

/** 下发升级后等待 Agent 以新版本重新上报的最长时间 */
const UPGRADE_TIMEOUT_MS = 120_000;

/** 主控托管的 Agent 版本、节点连接冲突，以及下发升级 */
export default function useAgentFleet(nodes: NodeDetail[]) {
  const { t } = useTranslation();
  const [hostedVersion, setHostedVersion] = useState("");
  const [conflicts, setConflicts] = useState<Record<string, AgentConflict>>({});
  /** uuid -> 是否在线；首次返回前为 null */
  const [online, setOnline] = useState<Record<string, boolean> | null>(null);
  /** 已下发升级、还没看到新版本的节点：uuid -> 下发时间 */
  const [upgrading, setUpgrading] = useState<Record<string, number>>({});
  const upgradingRef = useRef(upgrading);
  upgradingRef.current = upgrading;

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
        .call<unknown, Record<string, { online?: boolean }>>("common:getNodesLatestStatus")
        .then((data) => {
          if (cancelled || !data) return;
          setOnline(
            Object.fromEntries(Object.entries(data).map(([uuid, status]) => [uuid, !!status?.online])),
          );
        })
        .catch(() => {});
      getRPC2Client()
        .call<unknown, Record<string, AgentConflict>>("admin:getAgentConflicts", {})
        .then((data) => {
          if (!cancelled) setConflicts(data ?? {});
        })
        .catch(() => {});
    };
    loadConflicts();
    const interval = setInterval(loadConflicts, 10000);
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
        setUpgrading((current) => ({ ...current, [uuid]: Date.now() }));
        return "queued";
      } catch {
        return "failed";
      }
    },
    [hostedVersion],
  );

  // 升级结果：节点以托管版本重新上报即成功；超时仍是旧版本则提示去看 Agent 日志
  useEffect(() => {
    const pending = upgradingRef.current;
    if (Object.keys(pending).length === 0) return;
    const remaining: Record<string, number> = {};
    for (const [uuid, since] of Object.entries(pending)) {
      const node = nodes.find((item) => item.uuid === uuid);
      if (!node) continue;
      if (!isOutdated(node.version, hostedVersion)) {
        toast.success(t("admin.nodeTable.agentUpgradeDone", { name: node.name, version: node.version }));
      } else if (Date.now() - since > UPGRADE_TIMEOUT_MS) {
        toast.error(t("admin.nodeTable.agentUpgradeTimeout", { name: node.name, version: node.version }));
      } else {
        remaining[uuid] = since;
      }
    }
    if (Object.keys(remaining).length !== Object.keys(pending).length) setUpgrading(remaining);
  }, [nodes, hostedVersion, t]);

  return { hostedVersion, conflicts, online, upgrading, upgrade };
}

export type AgentFleet = ReturnType<typeof useAgentFleet>;
