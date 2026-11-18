-- Requested domain ownership change. GAM report dates before 2026-11-18 keep
-- their original settlement channel. A root covers itself and every subdomain.
INSERT OR IGNORE INTO gam_domain_channel_assignments(root_domain,channel_id,effective_from,created_by)
SELECT roots.domain,c.id,'2026-11-18','domain transfer 2026-11-18'
FROM (SELECT 'youxiglobal.xyz' domain UNION ALL SELECT 'youxibase.xyz'
      UNION ALL SELECT 'playzhan.life' UNION ALL SELECT 'youxicore.online') roots
JOIN channels c ON c.name='赵飞' AND c.status='active';
