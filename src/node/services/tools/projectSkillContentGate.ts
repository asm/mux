import type { ToolConfiguration } from "@/common/utils/tools/tools";

/**
 * Whether THIS tool call must leave project skill content out of what it
 * reads or returns: the assembly-time verdict (an untrusted routed turn), or a
 * routed turn's trust re-read at the call. A revocation between assembly and
 * a tool that talks to another provider itself (intuition) or reads history
 * and memories cannot wait for the next step's consent gate. Fails closed
 * when the re-read throws.
 */
export async function toolExcludesProjectSkillContent(
  config: Pick<ToolConfiguration, "excludeProjectSkillContent" | "projectSkillContentStillReadable">
): Promise<boolean> {
  if (config.excludeProjectSkillContent === true) return true;
  if (config.projectSkillContentStillReadable === undefined) return false;
  try {
    return !(await config.projectSkillContentStillReadable());
  } catch {
    return true;
  }
}
