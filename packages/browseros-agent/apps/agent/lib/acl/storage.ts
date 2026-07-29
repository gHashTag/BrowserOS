import type { AclRule } from '@browseros/shared/types/acl'
import { storage } from '#imports'

export const aclRulesStorage = storage.defineItem<AclRule[]>(
  'local:acl-rules',
  { fallback: [] },
)
