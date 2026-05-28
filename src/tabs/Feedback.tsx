import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { GITHUB_ISSUES } from "../constants";

export default function Feedback() {
  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Feedback</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Found a bug or have an idea? Open an issue on GitHub. Please include
            your OS version and, if relevant, the city / date that triggered the
            problem.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => openUrl(GITHUB_ISSUES)}>
          Open GitHub Issues
        </Button>
      </CardContent>
    </Card>
  );
}
