# Molo Voice Agent Dashboard — Architecture Diagrams

All diagrams in Mermaid. Grounded in the actual code (`supabase/functions/api`, `src/lib`, and the schema in `MOLO_PLAN.md §10`).

> Note: the edge auth middleware reads the `SESSION_SECRET` env var (see `middleware/auth.ts` and `lib/jwt.ts`), even though `CLAUDE.md` labels it `JWT_SECRET`. Diagrams below use the code's real name.

---

## 1. Deployment & trust boundary

```mermaid
graph TB
    subgraph browser["🌐 Browser (staff / guest)"]
        SPA["Static Next.js bundle (out/)<br/>Client Components · TanStack Query · apiFetch()"]
        LS[("localStorage<br/>molo_token (JWT)<br/>molo_session (user)")]
        SPA -. reads/writes .-> LS
    end

    subgraph render["Render — static_site"]
        CDN["Serves out/ static assets"]
    end

    subgraph supa["Supabase"]
        Edge["Edge Function: api (Hono / Deno)<br/>🔑 SERVICE_ROLE_KEY + SESSION_SECRET"]
        PG[("PostgreSQL")]
    end

    Voice["Molo Voice Agent<br/>(separate repo)"]

    SPA -->|"HTTPS page load"| CDN
    SPA -->|"HTTPS /api/* + Bearer JWT"| Edge
    Edge -->|"service-role queries"| PG
    Voice -->|"writes call_logs"| PG

    classDef secret fill:#ffe0e6,stroke:#b3324c,color:#000
    class Edge secret
    classDef nosecret fill:#e6f4ff,stroke:#2c6ecb,color:#000
    class SPA nosecret
```

The single trust line: the browser (blue) holds **no** secret; the edge function (red) alone holds the service-role key and signs/verifies JWTs.

---

## 2. Entity–Relationship diagram (schema the dashboard surfaces)

```mermaid
erDiagram
    properties ||--o{ knowledge_bases : "has (nullable, cascade)"
    properties ||--o{ property_rooms : "contains"
    properties ||--o{ call_logs : "logged against (set null)"
    properties ||--o{ maintenance_tickets : "located at (restrict)"
    knowledge_bases ||--o{ knowledge_base_rooms : "covers rooms (cascade)"
    call_logs ||--o{ maintenance_tickets : "raised from (set null)"
    urgency_rules ||--o{ maintenance_tickets : "classified by (set null)"

    users {
        uuid id PK
        text username UK
        text password_hash
        text display_name
        boolean is_active
        timestamptz last_login_at
    }
    properties {
        uuid id PK
        text name UK
        text address
        integer kwhotel_hotel_id
        jsonb aliases
        text language_default "en|pl"
        text timezone
    }
    knowledge_bases {
        uuid id PK
        uuid property_id FK "null for general"
        text name
        text kind "general|property|exception"
        text content
        boolean is_default_general "only one true"
    }
    knowledge_base_rooms {
        uuid id PK
        uuid knowledge_base_id FK
        text room_number "free-text"
    }
    urgency_rules {
        uuid id PK
        text level "critical|high|medium|low"
        text name
        jsonb examples
        jsonb keywords
        integer sort_order
    }
    call_logs {
        uuid id PK
        uuid property_id FK
        timestamptz started_at
        text direction "inbound|outbound"
        text mode "booking|guest|mixed|unknown"
        text outcome
        text sentiment
        numeric cost_usd
        jsonb tool_calls
    }
    maintenance_tickets {
        uuid id PK
        uuid property_id FK
        uuid call_id FK
        uuid urgency_rule_id FK
        text room_number
        text urgency "critical|high|medium|low"
        text status "open|in_progress|resolved|cancelled"
        text created_via "call|dashboard"
    }
    property_rooms {
        uuid property_id FK
        text room_number
    }
```

> `booking_links` and `agent_settings` exist in the SQL schema but were **cut from the dashboard** during the static migration, so they are omitted here.

---

## 3. Login sequence (auth issuance)

```mermaid
sequenceDiagram
    actor U as Staff
    participant SPA as Login page
    participant Edge as Edge api · /auth/login
    participant DB as Postgres · users

    U->>SPA: username + password
    SPA->>Edge: POST /api/auth/login
    Edge->>DB: select user by lower(username)
    DB-->>Edge: user row (or null)
    Note over Edge: bcrypt.compare vs real hash<br/>OR DUMMY_HASH — one compare<br/>always (no enumeration timing leak)
    alt valid & is_active
        Edge->>Edge: signToken() HS256, 12h<br/>sub=userId, username, displayName
        Edge-->>SPA: 200 { token, user }
        SPA->>SPA: localStorage.molo_token + molo_session
        SPA->>U: router.replace("/")
    else invalid / inactive
        Edge-->>SPA: 401 Invalid credentials
    end
```

---

## 4. Authenticated request lifecycle (every other call)

```mermaid
sequenceDiagram
    participant Q as TanStack Query hook
    participant F as apiFetch()
    participant CORS as CORS middleware
    participant Auth as requireAuth
    participant R as Route handler
    participant SB as serviceClient()
    participant DB as Postgres

    Q->>F: read/mutate
    F->>F: getToken() ← localStorage.molo_token
    F->>CORS: /api/... + Authorization: Bearer JWT
    Note over CORS: allow localhost:3000,<br/>ALLOWED_ORIGINS, *.onrender.com
    CORS->>Auth: origin ok
    Auth->>Auth: verifyToken(JWT, SESSION_SECRET)
    alt token valid
        Auth->>R: c.set("user", claims); next()
        R->>SB: query (service role)
        SB->>DB: SQL
        DB-->>R: rows
        R-->>Q: 200 JSON
    else missing / expired / bad
        Auth-->>F: 401 Unauthorized
        F->>F: clearToken() +<br/>dispatch "molo:unauthorized"
        Note over F: auth-context logout()<br/>→ router.replace("/login")
    end
```

---

## 5. Edge API route map (public vs. JWT-protected)

```mermaid
graph LR
    root["/api"] --> health["GET /health · public"]
    root --> auth["POST /auth/login · public"]
    root --> mw{{"requireAuth<br/>Bearer JWT (SESSION_SECRET)"}}
    mw --> props["/properties"]
    mw --> maint["/maintenance"]
    mw --> calls["/calls"]
    mw --> urg["/urgency-rules"]
    mw --> met["/metrics"]
    mw --> me["/me"]
    mw --> kb["/knowledge-bases"]

    classDef pubc fill:#e7f9ed,stroke:#2f9e57,color:#000
    class health,auth pubc
```

---

## 6. Frontend route / navigation map

```mermaid
graph TD
    login["/login · public"] -->|on success| home["/ · dashboard home<br/>metrics + recent activity"]
    home --> props["/properties · CRUD (8 props)"]
    home --> kb["/knowledge-bases · list + General KB"]
    kb --> kbnew["/knowledge-bases/new"]
    kb --> kbdetail["/knowledge-bases/detail<br/>KB editor — 2-col, most complex"]
    home --> maint["/maintenance · tickets"]
    maint --> maintd["/maintenance/detail"]
    home --> calls["/calls · call logs"]
    calls --> calld["/calls/detail<br/>transcript · recording · tool trace"]
    home --> su["/settings/users · self-profile"]
    home --> sur["/settings/urgency-rules · drag-reorder"]

    classDef pubc fill:#e7f9ed,stroke:#2f9e57,color:#000
    class login pubc
```

---

## 7. Knowledge-base priority resolution (`kb_for_room`)

```mermaid
flowchart TD
    start(["📞 Call starts"]) --> gen["Preload default general KB<br/>is_default_general = true · priority 1"]
    gen --> lookup{"Reservation lookup →<br/>property + room resolved?"}
    lookup -- no --> stayGen["Agent uses general KB only"]
    lookup -- yes --> prop["Swap in property KB<br/>kind = property · priority 2"]
    prop --> exc{"Room has an<br/>exception KB?<br/>kind = exception"}
    exc -- yes --> override["Exception KB overrides<br/>priority 3 — WINS"]
    exc -- no --> useProp["Property KB applies"]

    classDef win fill:#fff4d6,stroke:#c48f00,color:#000
    class override,useProp,stayGen win
```

The `kb_for_room` view returns every applicable KB for a `(property, room)` pair with `priority = exception(3) > property(2) > general(1)`; app code orders by priority DESC to pick the winner.

---

## 8. KB editor operations → endpoints (the most complex page)

```mermaid
graph LR
    subgraph editor["/knowledge-bases/detail (2-column editor)"]
        rename["Rename"]
        content["Edit content"]
        setgen["Toggle 'default general'"]
        assign["Assign rooms"]
        unassign["Remove one room"]
        del["Delete KB"]
    end
    rename --> P1["PATCH /knowledge-bases/:id { name }"]
    content --> P2["PATCH /knowledge-bases/:id { content }"]
    setgen --> P3["POST /knowledge-bases/:id/general { value }<br/>clears previous default first"]
    assign --> P4["PUT /knowledge-bases/:id/rooms<br/>delete-all + re-insert (deduped)"]
    unassign --> P5["DELETE /knowledge-bases/:id/rooms { roomNumber }"]
    del --> P6["DELETE /knowledge-bases/:id<br/>rooms first, then KB"]
```

---

## 9. Maintenance ticket state machine (`status` enum)

```mermaid
stateDiagram-v2
    [*] --> open: created (created_via = call | dashboard)
    open --> in_progress: staff starts work
    open --> resolved: sets resolved_at
    open --> cancelled
    in_progress --> resolved: sets resolved_at
    in_progress --> cancelled
    resolved --> [*]
    cancelled --> [*]
```
