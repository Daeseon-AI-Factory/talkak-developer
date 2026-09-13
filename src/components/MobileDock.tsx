import type { AppSection } from "../domain";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";

interface MobileDockProps {
  activeSection: AppSection;
  attentionCount: number;
  onSelectSection: (section: AppSection) => void;
}

export function MobileDock({ activeSection, attentionCount, onSelectSection }: MobileDockProps) {
  const { t } = useI18n();
  const items: { id: AppSection; icon: IconName; label: string }[] = [
    { id: "attention", icon: "bell", label: t("nav.attention") },
    { id: "workspace", icon: "terminal", label: t("nav.workspace") },
    { id: "sessions", icon: "sessions", label: t("nav.sessions") },
    { id: "settings", icon: "settings", label: t("nav.settings") },
  ];

  return (
    <nav className="mobile-dock" aria-label={t("mobile.dockAria")}>
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          data-active={activeSection === item.id}
          aria-current={activeSection === item.id ? "page" : undefined}
          aria-label={
            item.id === "attention" && attentionCount > 0
              ? `${item.label}, ${t("attention.openCount", { count: attentionCount })}`
              : undefined
          }
          onClick={() => onSelectSection(item.id)}
        >
          <span className="mobile-dock__icon">
            <Icon name={item.icon} size={19} />
            {item.id === "attention" && attentionCount > 0 ? (
              <span className="mobile-dock__badge" aria-hidden="true">
                {attentionCount}
              </span>
            ) : null}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
