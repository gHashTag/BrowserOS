export type TRIOSAgentRoleId = 'chief-of-staff'

export interface TRIOSRoleBoundary {
  key: string
  label: string
  description: string
  defaultMode: 'allow' | 'ask' | 'block'
}

export interface TRIOSRoleTemplate {
  id: TRIOSAgentRoleId
  name: string
  shortDescription: string
  longDescription: string
  recommendedApps: string[]
  defaultAgentName: string
  bootstrap: {
    agentsMd: string
    soulMd: string
    toolsMd: string
  }
  boundaries: TRIOSRoleBoundary[]
}

export interface TRIOSCustomRoleInput {
  name: string
  shortDescription: string
  longDescription: string
  recommendedApps: string[]
  boundaries: TRIOSRoleBoundary[]
  bootstrap?: {
    agentsMd?: string
    soulMd?: string
    toolsMd?: string
  }
}

export interface RoleAwareCreateAgentInput {
  name: string
  roleId?: TRIOSAgentRoleId
  customRole?: TRIOSCustomRoleInput
  providerType?: string
  providerName?: string
  baseUrl?: string
  apiKey?: string
  modelId?: string
}

export interface TRIOSAgentRoleSummary {
  roleSource: 'builtin' | 'custom'
  roleId?: TRIOSAgentRoleId
  roleName: string
  shortDescription: string
}
