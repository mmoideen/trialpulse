import { ROLE_POLICIES, type Role } from '@trialpulse/shared';
import { roleLabel } from '../utils/labels';
import styles from './RoleBadge.module.css';

export interface RoleBadgeProps {
  role: Role;
}

/** Shows the caller's active role, plus the "ADMIN ACCESS" watermark PRD 3.1 requires for it_admin. */
export function RoleBadge({ role }: RoleBadgeProps) {
  const watermark = ROLE_POLICIES[role].redaction.adminWatermark;
  return (
    <span>
      <span className={styles.badge} title={ROLE_POLICIES[role].description}>
        {roleLabel(role)}
      </span>
      {watermark ? <span className={styles.watermark}>ADMIN ACCESS</span> : null}
    </span>
  );
}
