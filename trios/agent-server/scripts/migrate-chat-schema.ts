#!/usr/bin/env bun

/**
 * Migration script: Add title and metadata columns to conversations table
 */

import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL

if (!DATABASE_URL) {
  console.error(
    'ERROR: DATABASE_URL or RAILWAY_SSOT_URL environment variable is required',
  )
  process.exit(1)
}

async function runMigration() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('neon.tech')
      ? { rejectUnauthorized: false }
      : undefined,
  })

  try {
    console.log(
      'Starting migration: Add title and metadata to conversations...',
    )

    // Check if columns already exist
    const checkResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'conversations' 
        AND column_name IN ('title', 'metadata')
    `)

    const existingColumns = checkResult.rows.map((r) => r.column_name)
    console.log('Existing columns:', existingColumns)

    // Add title column if not exists
    if (!existingColumns.includes('title')) {
      console.log('Adding "title" column...')
      await pool.query(`
        ALTER TABLE conversations 
        ADD COLUMN IF NOT EXISTS "title" TEXT
      `)
      console.log('✓ Added "title" column')
    } else {
      console.log('Column "title" already exists')
    }

    // Add metadata column if not exists
    if (!existingColumns.includes('metadata')) {
      console.log('Adding "metadata" column...')
      await pool.query(`
        ALTER TABLE conversations 
        ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb
      `)
      console.log('✓ Added "metadata" column')
    } else {
      console.log('Column "metadata" already exists')
    }

    // Check if metadata column exists in conversationMessages
    const checkMsgResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'conversationMessages' 
        AND column_name = 'metadata'
    `)

    if (checkMsgResult.rows.length === 0) {
      console.log('Adding "metadata" column to conversationMessages...')
      await pool.query(`
        ALTER TABLE "conversationMessages" 
        ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb
      `)
      console.log('✓ Added "metadata" column to conversationMessages')
    } else {
      console.log('Column "metadata" already exists in conversationMessages')
    }

    console.log('\n✅ Migration completed successfully!')
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

runMigration()
