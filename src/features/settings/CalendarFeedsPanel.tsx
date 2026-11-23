import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { CalendarFeed, FeedVisibility } from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import styles from "./CalendarFeedsPanel.module.css";

/** Couleurs proposées pour distinguer un calendrier abonné dans l'agenda. */
export const FEED_COLORS = [
  "#e08a52",
  "#4f8cf7",
  "#3fb97f",
  "#c77dff",
  "#f2c94c",
  "#ef6b6b",
] as const;

const COLOR_NAMES: Record<(typeof FEED_COLORS)[number], string> = {
  "#e08a52": "Orange",
  "#4f8cf7": "Bleu",
  "#3fb97f": "Vert",
  "#c77dff": "Violet",
  "#f2c94c": "Jaune",
  "#ef6b6b": "Rouge",
};

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "adresse enregistrée";
  }
}

function formatSync(iso: string | null): string {
  if (!iso) return "jamais synchronisé";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "jamais synchronisé";
  return `synchronisé le ${date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
}

/**
 * Réglages des calendriers en ligne : abonnement par URL (lecture seule). L'utilisateur déclare
 * si le calendrier est public ou privé ; pour un privé, l'adresse n'étant pas encore chiffrée,
 * on déconseille l'ajout et on exige une confirmation explicite.
 */
export function CalendarFeedsPanel() {
  const nameId = useId();
  const urlId = useId();
  const visibilityId = useId();
  const warningId = useId();
  const [feeds, setFeeds] = useState<readonly CalendarFeed[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [visibility, setVisibility] = useState<FeedVisibility | null>(null);
  const [color, setColor] = useState<string>(FEED_COLORS[0]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    try {
      setFeeds(await getIpc().calendarFeedList());
      setLoadError("");
    } catch (reason) {
      setFeeds([]);
      setLoadError(messageOf(reason, "Impossible de lire les calendriers."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setName("");
    setUrl("");
    setVisibility(null);
    setColor(FEED_COLORS[0]);
    setAcknowledged(false);
    setFormError("");
  };

  const canSubmit =
    name.trim() !== "" &&
    url.trim() !== "" &&
    visibility !== null &&
    (visibility === "public" || acknowledged) &&
    !saving;

  const submit = async () => {
    if (!canSubmit || visibility === null) return;
    setSaving(true);
    setFormError("");
    try {
      await getIpc().calendarFeedAdd({ name: name.trim(), url: url.trim(), visibility, color });
      await load();
      resetForm();
      setFormOpen(false);
      window.dispatchEvent(new Event("dayali:feeds-updated"));
    } catch (reason) {
      setFormError(messageOf(reason, "Le calendrier n'a pas pu être ajouté."));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async (feedId?: string) => {
    setBusyId(feedId ?? "all");
    setActionError("");
    try {
      setFeeds(await getIpc().calendarFeedRefresh(feedId ? { feedId } : undefined));
      window.dispatchEvent(new Event("dayali:feeds-updated"));
    } catch (reason) {
      setActionError(messageOf(reason, "L'actualisation a échoué."));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (feedId: string) => {
    setBusyId(feedId);
    setActionError("");
    try {
      await getIpc().calendarFeedRemove({ feedId });
      setConfirmingId(null);
      await load();
      window.dispatchEvent(new Event("dayali:feeds-updated"));
    } catch (reason) {
      setActionError(messageOf(reason, "La suppression a échoué."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Abonnez-vous à un calendrier en ligne (Google Agenda, iCloud, Outlook, jours fériés…) avec
        son adresse iCal. Ses événements s'affichent dans l'agenda, en lecture seule.
      </p>

      {loadError ? (
        <p role="alert" className={styles.error}>
          {loadError}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className={styles.error}>
          {actionError}
        </p>
      ) : null}

      {feeds === null ? (
        <p role="status" className={styles.muted}>
          Chargement des calendriers…
        </p>
      ) : feeds.length === 0 ? (
        <p className={styles.muted}>Aucun calendrier en ligne pour l'instant.</p>
      ) : (
        <ul className={styles.list}>
          {feeds.map((feed) => (
            <li key={feed.id} className={styles.item}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: feed.color ?? "var(--color-accent)" }}
                aria-hidden="true"
              />
              <div className={styles.itemBody}>
                <p className={styles.itemName}>
                  <strong>{feed.name}</strong>
                  <span
                    className={
                      feed.visibility === "private" ? styles.badgePrivate : styles.badgePublic
                    }
                  >
                    {feed.visibility === "private" ? "Privé" : "Public"}
                  </span>
                </p>
                <p className={styles.itemMeta}>
                  {feed.visibility === "private" ? "Adresse privée" : hostOf(feed.url)} ·{" "}
                  {feed.eventsCount} événement{feed.eventsCount > 1 ? "s" : ""} ·{" "}
                  {formatSync(feed.lastFetchedAt)}
                </p>
                {feed.error ? (
                  <p role="alert" className={styles.error}>
                    {feed.error} Les derniers événements connus restent affichés.
                  </p>
                ) : null}
              </div>
              <div className={styles.itemActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId !== null}
                  aria-label={`Actualiser ${feed.name}`}
                  onClick={() => void refresh(feed.id)}
                >
                  {busyId === feed.id ? "…" : "Actualiser"}
                </Button>
                {confirmingId === feed.id ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId !== null}
                      aria-label={`Confirmer la suppression de ${feed.name}`}
                      onClick={() => void remove(feed.id)}
                    >
                      Confirmer
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingId(null)}>
                      Annuler
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    aria-label={`Supprimer ${feed.name}`}
                    onClick={() => setConfirmingId(feed.id)}
                  >
                    Supprimer
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {formOpen ? (
        <fieldset className={styles.form} aria-label="Ajouter un calendrier">
          <div className={styles.field}>
            <label htmlFor={nameId} className={styles.label}>
              Nom du calendrier
            </label>
            <input
              id={nameId}
              className={styles.input}
              type="text"
              value={name}
              maxLength={80}
              placeholder="Ex : Jours fériés, Famille…"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor={urlId} className={styles.label}>
              Adresse du calendrier (iCal)
            </label>
            <input
              id={urlId}
              className={styles.input}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              placeholder="https://… ou webcal://…"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <fieldset className={styles.fieldset} aria-describedby={visibilityId}>
            <legend className={styles.label}>Ce calendrier est-il public ou privé ?</legend>
            <p id={visibilityId} className={styles.hint}>
              Public : n'importe qui peut le consulter (jours fériés, calendrier sportif…). Privé :
              l'adresse donne accès à vos propres événements.
            </p>
            <div className={styles.choices}>
              <label
                className={`${styles.choice} ${visibility === "public" ? styles.choiceActive : ""}`}
              >
                <input
                  type="radio"
                  name="feed-visibility"
                  checked={visibility === "public"}
                  onChange={() => setVisibility("public")}
                />
                <span>
                  <strong>Public</strong>
                  <small>Sans risque à ajouter.</small>
                </span>
              </label>
              <label
                className={`${styles.choice} ${visibility === "private" ? styles.choiceActive : ""}`}
              >
                <input
                  type="radio"
                  name="feed-visibility"
                  checked={visibility === "private"}
                  onChange={() => setVisibility("private")}
                />
                <span>
                  <strong>Privé</strong>
                  <small>Déconseillé pour l'instant.</small>
                </span>
              </label>
            </div>
          </fieldset>

          {visibility === "private" ? (
            <div className={styles.warning} role="alert" id={warningId}>
              <p>
                <strong>
                  Nous vous recommandons de ne pas encore ajouter de calendrier privé.
                </strong>
              </p>
              <p>
                L'adresse d'un calendrier privé n'est pas chiffrée : elle est enregistrée en clair
                sur cet ordinateur, et toute personne qui la récupère peut lire votre calendrier. Le
                chiffrement arrivera avec le coffre sécurisé.
              </p>
              <label className={styles.ack}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  aria-describedby={warningId}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>Je comprends que l'adresse sera stockée sans chiffrement.</span>
              </label>
            </div>
          ) : null}

          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>Couleur dans l'agenda</legend>
            <div className={styles.colors}>
              {FEED_COLORS.map((swatch) => (
                <label key={swatch} className={styles.colorChoice}>
                  <input
                    type="radio"
                    name="feed-color"
                    checked={color === swatch}
                    aria-label={COLOR_NAMES[swatch]}
                    onChange={() => setColor(swatch)}
                  />
                  <span className={styles.colorDot} style={{ backgroundColor: swatch }} />
                </label>
              ))}
            </div>
          </fieldset>

          {formError ? (
            <p role="alert" className={styles.error}>
              {formError}
            </p>
          ) : null}

          <div className={styles.formActions}>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              Annuler
            </Button>
            <Button size="sm" variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
              {saving ? "Vérification du calendrier…" : "Ajouter le calendrier"}
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className={styles.toolbar}>
          <Button size="sm" variant="secondary" onClick={() => setFormOpen(true)}>
            Ajouter un calendrier
          </Button>
          {feeds && feeds.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId !== null}
              onClick={() => void refresh()}
            >
              {busyId === "all" ? "Actualisation…" : "Tout actualiser"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
