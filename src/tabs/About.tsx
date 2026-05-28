import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Status } from "../types";
import { GITHUB_REPO, wikipediaUrl } from "../constants";

type Props = { status: Status };

export default function About({ status }: Props) {
  const city = status.city;

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">InkCity</h2>
          <p className="text-sm text-muted-foreground mt-1">
            InkCity sets your desktop wallpaper to a road map of a different city
            every day. The city for each day is picked deterministically from a
            list of the world's 1,000 most populous cities, so everyone running
            InkCity sees the same city on the same day.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Road geometry is fetched from OpenStreetMap via the Overpass API and
            rendered locally. Cached data is kept for 7 days under your app cache
            directory.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => openUrl(GITHUB_REPO)}>
            GitHub repository
          </Button>
          <Button variant="outline" size="sm" onClick={() => openUrl(wikipediaUrl(city.name))}>
            Wikipedia: {city.name}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
