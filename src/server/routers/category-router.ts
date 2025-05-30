import { db } from "@/db";
import { router } from "../__internals/router";
import { privateProcedure } from "../procedures";
import { startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { z } from "zod";
import { CATEGORY_NAME_VALIDATOR } from "@/lib/validators/category-validator";
import { parseColor } from "@/lib/utils";
import { HTTPException } from "hono/http-exception";

export const categoryRouter = router({
    // Get all event categories for the current user
    getEventCategories: privateProcedure.query(async ({ c, ctx }) => {
        const categories = await db.eventCategory.findMany({
            where: {
                userId: ctx.user.id,
            },
            select: {
                id: true,
                name: true,
                emoji: true,
                color: true,
                updatedAt: true,
                createdAt: true,
            },
            orderBy: {
                updatedAt: "desc",
            },
        });
        const categoriesWithCounts = await Promise.all(
            categories.map(async (category) => {
                const now = new Date();
                const firstDayOfMonth = startOfMonth(now);
                const [uniqueFieldCount, eventCount, lastPing] = await Promise.all([
                    //first promise
                    db.event.findMany({
                        where: {
                            EventCategory: { id: category.id },
                            createdAt: { gte: firstDayOfMonth },
                        },
                        select: { fields: true },
                        distinct: ["fields"]
                    }).then((events) => {
                        const fieldNames = new Set<string>();
                        events.forEach((event) => {
                            Object.keys(event.fields as object).forEach((fieldName) => {
                                fieldNames.add(fieldName);
                            })
                        })
                        return fieldNames.size;
                    }),
                    //second promise
                    db.event.count({
                        where: {
                            EventCategory: { id: category.id },
                            createdAt: { gte: firstDayOfMonth },
                        }
                    }),
                    //third promise
                    db.event.findFirst({
                        where: { EventCategory: { id: category.id }, },
                        orderBy: { createdAt: "asc", },
                        select: { createdAt: true, }
                    })
                ])
                return {
                    ...category,
                    uniqueFieldCount,
                    eventCount,
                    lastPing: lastPing?.createdAt || null
                }
            })
        )
        return c.superjson({ categories: categoriesWithCounts })
    }),
    // Delete a category
    deleteCategory: privateProcedure
        .input(z.object({ name: z.string() }))
        .mutation(async ({ c, input, ctx }) => {
            const { name } = input;
            await db.eventCategory.delete({
                where: {
                    name_userId: {
                        name,
                        userId: ctx.user.id
                    }
                }
            })
            return c.json({ success: true });
        }),
    //create new event category
    createEventCategory: privateProcedure
        .input(z.object({
            name: CATEGORY_NAME_VALIDATOR,
            color: z.string().min(1, "Color is required").regex(/^#[0-9A-F]{6}$/i, "Color must be a valid hex color"),
            emoji: z.string().emoji("Invalid Emoji").optional(),
        }))
        .mutation(async ({ c, ctx, input }) => {
            const { user } = ctx;
            const { name, color, emoji } = input;

            //TODO: Add paid plan logic

            const eventCategory = await db.eventCategory.create({
                data: {
                    name: name.toLowerCase(),
                    color: parseColor(color),
                    emoji: emoji,
                    userId: user.id,
                },
            });

            return c.json({ eventCategory })
        }),
    //inserting quick start categories
    insertQuickStartCategories: privateProcedure.mutation(async ({ c, ctx }) => {

        const categories = await db.eventCategory.createMany({
            data: [
                { name: 'bug', emoji: '🐛', color: 0xff6b6b, },
                { name: 'sale', emoji: '🤑', color: 0xffeb6b, },
                { name: 'question', emoji: '😕', color: 0x6c5ce7, },
            ].map((category) => ({ ...category, userId: ctx.user.id, })),
        });

        return c.json({ success: true, count: categories.count });
    }),
    //polling for category events
    pollCategory: privateProcedure
        .input(z.object({ name: CATEGORY_NAME_VALIDATOR }))
        .query(async ({ c, ctx, input }) => {
            const { name } = input;
            const category = await db.eventCategory.findUnique({
                where: {
                    name_userId: {
                        name,
                        userId: ctx.user.id,
                    },
                },
                include: {
                    _count: {
                        select: {
                            events: true,
                        },
                    },
                },
            });
            if (!category) {
                throw new HTTPException(404, { message: `Category ${name} not found` });
            }
            const hasEvents = category._count.events > 0;
            return c.json({ hasEvents });
        }),
    //get events by category name
    getEventsByCategoryName: privateProcedure
        .input(z.object({
            name: CATEGORY_NAME_VALIDATOR,
            page: z.number(),
            limit: z.number().max(50),
            timeRange: z.enum(["today", "week", "month"])
        })).query(async ({ c, ctx, input }) => {
            const { name, page, limit, timeRange } = input;
            const now = new Date();
            let startDate: Date;
            switch (timeRange) {
                case "today":
                    startDate = startOfDay(now);
                    break;
                case "week":
                    startDate = startOfWeek(now, { weekStartsOn: 0 });
                    break;
                case "month":
                    startDate = startOfMonth(now);
                    break;
            }
            const [events, eventsCount, uniqueFieldCount] = await Promise.all([
                //first promise
                db.event.findMany({
                    where: {
                        EventCategory: {
                            name,
                            userId: ctx.user.id
                        },
                        createdAt: {
                            gte: startDate
                        }
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy: {
                        createdAt: "desc"
                    }
                }),
                //second promise
                db.event.count({
                    where: {
                        EventCategory: {
                            name,
                            userId: ctx.user.id
                        },
                        createdAt: {
                            gte: startDate
                        }
                    }
                }),
                //third promise
                db.event.findMany({
                    where: {
                        EventCategory: {
                            name,
                            userId: ctx.user.id
                        },
                        createdAt: {
                            gte: startDate
                        }
                    },
                    select: {
                        fields: true
                    },
                    distinct: ["fields"]
                }).then((events) => {
                    const fieldNames = new Set<string>();
                    events.forEach((event) => {
                        Object.keys(event.fields as object).forEach((fieldName) => {
                            fieldNames.add(fieldName);
                        });
                    });
                    return fieldNames.size;
                })
            ]);
            return c.superjson({ events, eventsCount, uniqueFieldCount });
        })
})