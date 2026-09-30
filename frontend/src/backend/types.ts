export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_settings: {
        Row: {
          cost_per_min_usd: Json
          feature_flags: Json
          greeting_text: string
          id: string
          is_singleton: boolean
          system_prompt_main: string
          transfer_default_phone: string | null
          updated_at: string
        }
        Insert: {
          cost_per_min_usd?: Json
          feature_flags?: Json
          greeting_text?: string
          id?: string
          is_singleton?: boolean
          system_prompt_main?: string
          transfer_default_phone?: string | null
          updated_at?: string
        }
        Update: {
          cost_per_min_usd?: Json
          feature_flags?: Json
          greeting_text?: string
          id?: string
          is_singleton?: boolean
          system_prompt_main?: string
          transfer_default_phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      booking_links: {
        Row: {
          booking_option: string
          call_id: string | null
          check_in: string
          check_out: string
          clicked_at: string | null
          converted: boolean
          generated_url: string | null
          guest_name: string
          id: string
          num_guests: number
          phone: string
          property_address: string
          property_name: string
          sent_at: string
        }
        Insert: {
          booking_option: string
          call_id?: string | null
          check_in: string
          check_out: string
          clicked_at?: string | null
          converted?: boolean
          generated_url?: string | null
          guest_name: string
          id?: string
          num_guests: number
          phone: string
          property_address: string
          property_name: string
          sent_at?: string
        }
        Update: {
          booking_option?: string
          call_id?: string | null
          check_in?: string
          check_out?: string
          clicked_at?: string | null
          converted?: boolean
          generated_url?: string | null
          guest_name?: string
          id?: string
          num_guests?: number
          phone?: string
          property_address?: string
          property_name?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_links_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      call_logs: {
        Row: {
          cost_breakdown: Json | null
          cost_usd: number | null
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          from_number: string | null
          id: string
          language: string | null
          mode: string | null
          outcome: string | null
          outcomes: string[]
          property_id: string | null
          recording_url: string | null
          redacted_at: string | null
          redaction_reason: string | null
          reservation_id: string | null
          room_number: string | null
          sentiment: string | null
          started_at: string
          summary: string | null
          to_did: string | null
          tool_calls: Json
          transcript_url: string | null
        }
        Insert: {
          cost_breakdown?: Json | null
          cost_usd?: number | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          from_number?: string | null
          id?: string
          language?: string | null
          mode?: string | null
          outcome?: string | null
          outcomes?: string[]
          property_id?: string | null
          recording_url?: string | null
          redacted_at?: string | null
          redaction_reason?: string | null
          reservation_id?: string | null
          room_number?: string | null
          sentiment?: string | null
          started_at?: string
          summary?: string | null
          to_did?: string | null
          tool_calls?: Json
          transcript_url?: string | null
        }
        Update: {
          cost_breakdown?: Json | null
          cost_usd?: number | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          from_number?: string | null
          id?: string
          language?: string | null
          mode?: string | null
          outcome?: string | null
          outcomes?: string[]
          property_id?: string | null
          recording_url?: string | null
          redacted_at?: string | null
          redaction_reason?: string | null
          reservation_id?: string | null
          room_number?: string | null
          sentiment?: string | null
          started_at?: string
          summary?: string | null
          to_did?: string | null
          tool_calls?: Json
          transcript_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_base_rooms: {
        Row: {
          created_at: string
          id: string
          knowledge_base_id: string
          room_number: string
        }
        Insert: {
          created_at?: string
          id?: string
          knowledge_base_id: string
          room_number: string
        }
        Update: {
          created_at?: string
          id?: string
          knowledge_base_id?: string
          room_number?: string
        }
        Relationships: []
      }
      knowledge_bases: {
        Row: {
          content: string
          created_at: string
          id: string
          is_default_general: boolean
          kind: string
          name: string
          property_id: string | null
          updated_at: string
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          is_default_general?: boolean
          kind: string
          name: string
          property_id?: string | null
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          is_default_general?: boolean
          kind?: string
          name?: string
          property_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      maintenance_tickets: {
        Row: {
          call_id: string | null
          created_at: string
          created_via: string
          description: string
          id: string
          notes: string | null
          property_id: string
          reservation_id: string | null
          resolved_at: string | null
          room_number: string
          status: string
          updated_at: string
          urgency: string
          urgency_rule_id: string | null
        }
        Insert: {
          call_id?: string | null
          created_at?: string
          created_via?: string
          description: string
          id?: string
          notes?: string | null
          property_id: string
          reservation_id?: string | null
          resolved_at?: string | null
          room_number: string
          status?: string
          updated_at?: string
          urgency: string
          urgency_rule_id?: string | null
        }
        Update: {
          call_id?: string | null
          created_at?: string
          created_via?: string
          description?: string
          id?: string
          notes?: string | null
          property_id?: string
          reservation_id?: string | null
          resolved_at?: string | null
          room_number?: string
          status?: string
          updated_at?: string
          urgency?: string
          urgency_rule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_tickets_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_tickets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_tickets_urgency_rule_id_fkey"
            columns: ["urgency_rule_id"]
            isOneToOne: false
            referencedRelation: "urgency_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          address: string
          aliases: Json
          created_at: string
          id: string
          kwhotel_hotel_id: number | null
          language_default: string
          name: string
          notes: string | null
          timezone: string
          transfer_phone: string | null
          updated_at: string
        }
        Insert: {
          address: string
          aliases?: Json
          created_at?: string
          id?: string
          kwhotel_hotel_id?: number | null
          language_default?: string
          name: string
          notes?: string | null
          timezone?: string
          transfer_phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string
          aliases?: Json
          created_at?: string
          id?: string
          kwhotel_hotel_id?: number | null
          language_default?: string
          name?: string
          notes?: string | null
          timezone?: string
          transfer_phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      property_rooms: {
        Row: {
          created_at: string
          id: string
          property_id: string
          room_number: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id: string
          room_number: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string
          room_number?: string
        }
        Relationships: []
      }
      urgency_rules: {
        Row: {
          created_at: string
          examples: Json
          id: string
          keywords: Json
          level: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          examples?: Json
          id?: string
          keywords?: Json
          level: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          examples?: Json
          id?: string
          keywords?: Json
          level?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          last_login_at: string | null
          password_hash: string
          username: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          password_hash: string
          username: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          password_hash?: string
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      kb_for_room: {
        Row: {
          content: string | null
          kb_id: string | null
          kb_name: string | null
          kind: string | null
          priority: number | null
          property_id: string | null
          property_name: string | null
          room_number: string | null
        }
        Relationships: []
      }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"]
