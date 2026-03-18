import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { NEOTOMA_DEEP_URL } from "../../shared/recommendation_tool_urls";
import { getRecommendationBrandingFromUrl } from "../../shared/recommendation_branding.ts";

interface NeotomaInstallCardProps {
  relevance: string;
}

function NeotomaIcon() {
  const { iconUrls, monogram } = getRecommendationBrandingFromUrl("Neotoma", NEOTOMA_DEEP_URL);
  const [iconIndex, setIconIndex] = useState(0);
  const activeIconUrl = iconUrls[iconIndex];

  return (
    <div className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 overflow-hidden">
      {activeIconUrl ? (
        <img
          src={activeIconUrl}
          alt=""
          aria-hidden="true"
          className="w-5 h-5 object-contain"
          loading="lazy"
          onError={() => setIconIndex((prev) => prev + 1)}
        />
      ) : (
        <span className="text-sm font-semibold">{monogram}</span>
      )}
    </div>
  );
}

export default function NeotomaInstallCard({ relevance }: NeotomaInstallCardProps) {

  return (
    <div className="bg-card border-2 border-primary/20 rounded-xl p-5 shadow-[0px_15px_30px_0px_rgba(0,0,0,0.05)]">
      <div className="flex items-start gap-3 mb-3">
        <NeotomaIcon />
        <div>
          <h3 className="font-semibold text-foreground">Neotoma</h3>
          <p className="text-xs text-primary font-medium">
            Deterministic state layer for AI agents
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{relevance}</p>

      <a
        href={NEOTOMA_DEEP_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80"
      >
        Open Neotoma install guide
        <ExternalLink className="w-4 h-4" />
      </a>
    </div>
  );
}
